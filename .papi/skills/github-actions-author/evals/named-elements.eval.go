// Eval: named-elements
//
// Requires human-readable names throughout for legible run logs: the workflow
// `name:`, every job's `name:`, every step's `name:`, and — for composite action
// definitions (action.yml with `using: composite`) — the action `name:` and each
// composite step's `name:`. Composite actions are collected from action.yml /
// action.yaml files and from ```yaml blocks containing `using: composite`.
//
//	PASS:                          FAIL (unnamed step):     FAIL (unnamed job):
//	  name: CI                       name: CI                 name: CI
//	  jobs:                          jobs:                    jobs:
//	    build:                         build:                   build:
//	      name: Build                    name: Build              runs-on: ...
//	      steps:                         steps:                   steps:
//	        - name: Checkout               - run: echo hi           - name: X
//	          run: echo hi
//
// Score: 1.0 all named, 0.6 majority, 0.2 mostly unnamed, 0.5 nothing to check or
// yq unavailable, 0.0 skipped. NOTE: every step must be named, including uses:
// steps that GitHub would otherwise auto-name.
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

const evalID = "named-elements"
const evalName = "Workflows, jobs, and steps have non-empty names"

var codeBlockRe = regexp.MustCompile("(?s)```(?:ya?ml)?\\n([\\s\\S]*?)```")

func isWorkflow(src string) bool {
	hasJobs := regexp.MustCompile(`(?m)^jobs\s*:`).MatchString(src)
	hasTrigger := regexp.MustCompile(`(?m)^(on|"on"|'on')\s*:`).MatchString(src)
	hasRunsOn := strings.Contains(src, "runs-on")
	return hasJobs && (hasTrigger || hasRunsOn)
}

var compositeRe = regexp.MustCompile(`(?m)^\s*using:\s*['"]?composite`)

func isComposite(src string) bool { return compositeRe.MatchString(src) }

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

func extractCompositeBlocks(text string) []string {
	matches := codeBlockRe.FindAllStringSubmatch(text, -1)
	blocks := make([]string, 0, len(matches))
	for _, m := range matches {
		src := strings.TrimSpace(m[1])
		if isComposite(src) {
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

// collectActionFiles finds composite-action definitions (action.yml /
// action.yaml) anywhere under the working directory.
func collectActionFiles(workDir string) []string {
	if workDir == "" {
		return nil
	}
	sources := []string{}
	_ = filepath.Walk(workDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		base := strings.ToLower(info.Name())
		if base != "action.yml" && base != "action.yaml" {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr == nil && isComposite(string(data)) {
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

func blank(s string) bool { return strings.TrimSpace(s) == "" }

type workflowView struct {
	Name string `json:"name"`
	Jobs []struct {
		ID    string   `json:"id"`
		Name  string   `json:"name"`
		Steps []string `json:"steps"`
	} `json:"jobs"`
}

const workflowExpr = `{"name": .name, "jobs": (.jobs // {} | to_entries | map({"id": .key, "name": .value.name, "steps": (.value.steps // [] | map(.name // ""))}))}`

func workflowViolations(yq, src string) []string {
	out, ok := yqJSON(yq, src, workflowExpr)
	if !ok {
		return []string{"could not parse workflow"}
	}
	var view workflowView
	if err := json.Unmarshal(out, &view); err != nil {
		return []string{"could not parse workflow"}
	}
	problems := []string{}
	if blank(view.Name) {
		problems = append(problems, "workflow missing name")
	}
	for _, job := range view.Jobs {
		if blank(job.Name) {
			problems = append(problems, fmt.Sprintf("job '%s' missing name", job.ID))
		}
		for i, step := range job.Steps {
			if blank(step) {
				problems = append(problems, fmt.Sprintf("job '%s' step %d missing name", job.ID, i+1))
			}
		}
	}
	return problems
}

type actionView struct {
	Name  string   `json:"name"`
	Steps []string `json:"steps"`
}

const actionExpr = `{"name": .name, "steps": (.runs.steps // [] | map(.name // ""))}`

func actionViolations(yq, src string) []string {
	out, ok := yqJSON(yq, src, actionExpr)
	if !ok {
		return []string{"could not parse action"}
	}
	var view actionView
	if err := json.Unmarshal(out, &view); err != nil {
		return []string{"could not parse action"}
	}
	problems := []string{}
	if blank(view.Name) {
		problems = append(problems, "action missing name")
	}
	for i, step := range view.Steps {
		if blank(step) {
			problems = append(problems, fmt.Sprintf("composite step %d missing name", i+1))
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
		emit(0.5, "yq not available in eval environment — cannot inspect names.")
		return
	}

	workflows := collectWorkflowFiles(ctx.WorkDir)
	workflows = append(workflows, extractWorkflowBlocks(ctx.QualityTranscript)...)
	actions := collectActionFiles(ctx.WorkDir)
	actions = append(actions, extractCompositeBlocks(ctx.QualityTranscript)...)

	total := len(workflows) + len(actions)
	if total == 0 {
		emit(0.5, "No workflow or composite-action YAML found — nothing to check.")
		return
	}

	clean := 0
	firstViolation := ""
	for i, src := range workflows {
		if problems := workflowViolations(yq, src); len(problems) == 0 {
			clean++
		} else if firstViolation == "" {
			firstViolation = fmt.Sprintf("workflow %d: %s", i+1, problems[0])
		}
	}
	for i, src := range actions {
		if problems := actionViolations(yq, src); len(problems) == 0 {
			clean++
		} else if firstViolation == "" {
			firstViolation = fmt.Sprintf("action %d: %s", i+1, problems[0])
		}
	}

	ratio := float64(clean) / float64(total)
	switch {
	case ratio == 1.0:
		emit(1.0, fmt.Sprintf("All %d workflow(s)/action(s) name every workflow, job, and step.", total))
	case ratio >= 0.5:
		emit(0.6, fmt.Sprintf("%d/%d source(s) fully named. First issue — %s", clean, total, firstViolation))
	default:
		emit(0.2, fmt.Sprintf("Only %d/%d source(s) fully named. First issue — %s", clean, total, firstViolation))
	}
}
