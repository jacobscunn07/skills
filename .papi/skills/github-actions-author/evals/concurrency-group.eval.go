// Eval: concurrency-group
//
// Requires a top-level `concurrency:` block with a non-empty `group:` so
// superseded runs (e.g. rapid pushes to the same branch/PR) are grouped and can
// be cancelled instead of piling up. The string shorthand counts (that string
// IS the group); a map must contain a non-empty group.
//
//	PASS (map):                                PASS (shorthand):   FAIL:
//	  concurrency:                               concurrency: ci-x   (no concurrency:
//	    group: ci-${{ github.ref }}                                   at top level)
//	    cancel-in-progress: true
//
// Score: 1.0 all set, 0.6 majority, 0.2 mostly missing, 0.5 nothing to check or
// yq unavailable, 0.0 skill not invoked.
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

const evalID = "concurrency-group"
const evalName = "Every workflow sets a top-level concurrency group"

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

type concView struct {
	Conc interface{} `json:"conc"`
}

// violation returns a problem string if the workflow lacks a non-empty
// top-level concurrency group, or "" if it is compliant. concurrency may be a
// string shorthand (that string is the group) or a map with a `group:` key.
func violation(yq, src string) string {
	out, ok := yqJSON(yq, src, `{"conc": .concurrency}`)
	if !ok {
		return "could not parse workflow"
	}
	var view concView
	if err := json.Unmarshal(out, &view); err != nil {
		return "could not parse workflow"
	}
	switch t := view.Conc.(type) {
	case nil:
		return "missing top-level concurrency"
	case string:
		if strings.TrimSpace(t) == "" {
			return "concurrency group is empty"
		}
		return ""
	case map[string]interface{}:
		group, _ := t["group"].(string)
		if strings.TrimSpace(group) == "" {
			return "concurrency block missing a non-empty group"
		}
		return ""
	default:
		return "concurrency is not a group or mapping"
	}
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
		emit(0.5, "yq not available in eval environment — cannot inspect concurrency.")
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
		if problem := violation(yq, src); problem == "" {
			clean++
		} else if firstViolation == "" {
			firstViolation = fmt.Sprintf("workflow %d: %s", i+1, problem)
		}
	}

	origin := fmt.Sprintf("%d from disk, %d from response", fromDisk, total-fromDisk)
	ratio := float64(clean) / float64(total)
	switch {
	case ratio == 1.0:
		emit(1.0, fmt.Sprintf("Every workflow sets a concurrency group across %d workflow(s) (%s).", total, origin))
	case ratio >= 0.5:
		emit(0.6, fmt.Sprintf("%d/%d workflow(s) clean. First issue — %s", clean, total, firstViolation))
	default:
		emit(0.2, fmt.Sprintf("Only %d/%d workflow(s) clean. First issue — %s", clean, total, firstViolation))
	}
}
