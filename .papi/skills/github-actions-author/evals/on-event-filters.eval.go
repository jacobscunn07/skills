// Eval: on-event-filters
//
// Discourages over-triggering: the filterable events push, pull_request, and
// pull_request_target must be scoped with a filter (branches / branches-ignore /
// paths / paths-ignore / tags / tags-ignore / types / inputs). A bare trigger
// fails. All other events (schedule, workflow_dispatch, workflow_call, and
// non-filterable webhook events) are inherently specific and exempt.
//
//	PASS:                          FAIL (bare string):   FAIL (bare in map):   EXEMPT:
//	  on:                            on: push              on:                   on: workflow_dispatch
//	    push:                                                push:
//	      branches: [main]
//
// Handles the string / list / map forms of `on:`. Score: 1.0 all scoped, 0.6
// majority, 0.2 mostly bare, 0.5 nothing to check or yq unavailable, 0.0 skipped.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

type scenario struct {
	ID     string `json:"id"`
	Prompt string `json:"prompt"`
}

type evalContext struct {
	Scenario          scenario `json:"scenario"`
	QualityTranscript string   `json:"qualityTranscript"`
	Invoked           bool     `json:"invoked"`
	WorkDir           string   `json:"workDir"`
}

type evalResult struct {
	EvalID    string  `json:"evalId"`
	Name      string  `json:"name"`
	Score     float64 `json:"score"`
	Reasoning string  `json:"reasoning"`
}

const evalID = "on-event-filters"
const evalName = "Filterable on: events are scoped with a filter"

var codeBlockRe = regexp.MustCompile("(?s)```(?:ya?ml)?\\n([\\s\\S]*?)```")

func isWorkflow(src string) bool {
	hasJobs := regexp.MustCompile(`(?m)^jobs\s*:`).MatchString(src)
	hasTrigger := regexp.MustCompile(`(?m)^(on|"on"|'on')\s*:`).MatchString(src)
	hasRunsOn := strings.Contains(src, "runs-on")
	return hasJobs && (hasTrigger || hasRunsOn)
}

func extractWorkflowBlocks(text string) []string {
	matches := codeBlockRe.FindAllStringSubmatch(text, -1)
	blocks := make([]string, 0, len(matches))
	for _, m := range matches {
		src := strings.TrimSpace(m[1])
		if isWorkflow(src) {
			blocks = append(blocks, src)
		}
	}
	return blocks
}

func collectWorkflowFiles(workDir string) []string {
	if workDir == "" {
		return nil
	}
	root := filepath.Join(workDir, ".github", "workflows")
	sources := []string{}
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".yml" && ext != ".yaml" {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr == nil {
			sources = append(sources, string(data))
		}
		return nil
	})
	return sources
}

func emit(score float64, reasoning string) {
	json.NewEncoder(os.Stdout).Encode(evalResult{
		EvalID:    evalID,
		Name:      evalName,
		Score:     score,
		Reasoning: reasoning,
	})
}

func yqJSON(yq, src, expr string) ([]byte, bool) {
	cmd := exec.Command(yq, "-o=json", "-I=0", expr)
	cmd.Stdin = strings.NewReader(src)
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}
	return out, true
}

// filterableEvents are the events where triggering on every occurrence is a
// real over-trigger smell and a branches/paths/tags/types filter is expected.
// Everything else (schedule, workflow_dispatch, workflow_call, non-filterable
// webhook events, ...) is inherently specific and exempt.
var filterableEvents = map[string]bool{
	"push":                true,
	"pull_request":        true,
	"pull_request_target": true,
}

// filterKeys are the sub-keys that count as scoping an event.
var filterKeys = []string{
	"branches", "branches-ignore",
	"paths", "paths-ignore",
	"tags", "tags-ignore",
	"types", "inputs",
}

func hasFilter(v interface{}) bool {
	m, ok := v.(map[string]interface{})
	if !ok {
		return false
	}
	for _, k := range filterKeys {
		if _, present := m[k]; present {
			return true
		}
	}
	return false
}

type onView struct {
	On interface{} `json:"on"`
}

// normalizeEvents turns the polymorphic `on` value (string, list, or map) into
// an event-name -> config map. A bare event maps to nil.
func normalizeEvents(on interface{}) map[string]interface{} {
	events := map[string]interface{}{}
	switch t := on.(type) {
	case string:
		events[t] = nil
	case []interface{}:
		for _, e := range t {
			if name, ok := e.(string); ok {
				events[name] = nil
			}
		}
	case map[string]interface{}:
		for name, cfg := range t {
			events[name] = cfg
		}
	}
	return events
}

// violations returns filterable events that are triggered bare (no filter).
func violations(yq, src string) []string {
	out, ok := yqJSON(yq, src, `{"on": .["on"]}`)
	if !ok {
		return []string{"could not parse workflow"}
	}
	var view onView
	if err := json.Unmarshal(out, &view); err != nil {
		return []string{"could not parse workflow"}
	}
	problems := []string{}
	for name, cfg := range normalizeEvents(view.On) {
		if !filterableEvents[name] {
			continue // inherently-specific event — exempt
		}
		if !hasFilter(cfg) {
			problems = append(problems, fmt.Sprintf("on.%s has no filter (bare trigger)", name))
		}
	}
	return problems
}

func main() {
	var ctx evalContext
	if err := json.NewDecoder(os.Stdin).Decode(&ctx); err != nil {
		os.Stderr.WriteString("decode: " + err.Error() + "\n")
		os.Exit(1)
	}

	if !ctx.Invoked || ctx.QualityTranscript == "" {
		emit(0.0, "Skipped — skill not invoked.")
		return
	}

	yq, err := exec.LookPath("yq")
	if err != nil {
		emit(0.5, "yq not available in eval environment — cannot inspect triggers.")
		return
	}

	sources := collectWorkflowFiles(ctx.WorkDir)
	fromDisk := len(sources)
	sources = append(sources, extractWorkflowBlocks(ctx.QualityTranscript)...)

	if len(sources) == 0 {
		emit(0.5, "No GitHub Actions workflow YAML found — nothing to check.")
		return
	}

	clean, total := 0, len(sources)
	firstViolation := ""
	for i, src := range sources {
		if problems := violations(yq, src); len(problems) == 0 {
			clean++
		} else if firstViolation == "" {
			firstViolation = fmt.Sprintf("workflow %d: %s", i+1, problems[0])
		}
	}

	origin := fmt.Sprintf("%d from disk, %d from response", fromDisk, total-fromDisk)
	ratio := float64(clean) / float64(total)
	switch {
	case ratio == 1.0:
		emit(1.0, fmt.Sprintf("All filterable triggers are scoped across %d workflow(s) (%s).", total, origin))
	case ratio >= 0.5:
		emit(0.6, fmt.Sprintf("%d/%d workflow(s) clean. First issue — %s", clean, total, firstViolation))
	default:
		emit(0.2, fmt.Sprintf("Only %d/%d workflow(s) clean. First issue — %s", clean, total, firstViolation))
	}
}
