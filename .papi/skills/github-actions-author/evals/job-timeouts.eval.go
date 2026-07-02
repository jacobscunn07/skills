// Eval: job-timeouts
//
// Requires every job to declare `timeout-minutes:` so a hung job can't run for
// the default 6 hours, burning runner minutes. Jobs that only call a reusable
// workflow (job-level `uses:`) are exempt — GitHub forbids timeout-minutes there.
//
//	PASS:                          FAIL:                    EXEMPT (reusable):
//	  jobs:                          jobs:                    jobs:
//	    build:                         build:                   call:
//	      runs-on: ubuntu-latest         runs-on: ubuntu-latest    uses: org/repo/.github/workflows/x.yml@sha
//	      timeout-minutes: 15            steps: [...]
//
// Score: 1.0 every job set, 0.6 majority, 0.2 mostly missing, 0.5 nothing to
// check or yq unavailable, 0.0 skill not invoked.
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

const evalID = "job-timeouts"
const evalName = "Every job declares timeout-minutes"

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

type jobsView struct {
	Jobs []struct {
		Name    string      `json:"name"`
		Timeout interface{} `json:"timeout"`
		Uses    interface{} `json:"uses"`
	} `json:"jobs"`
}

const yqExpr = `{"jobs": (.jobs // {} | to_entries | map({"name": .key, "timeout": .value["timeout-minutes"], "uses": .value.uses}))}`

// violations returns jobs missing timeout-minutes. Jobs that call a reusable
// workflow (job-level `uses:`) are exempt — GitHub forbids timeout-minutes there.
func violations(yq, src string) []string {
	out, ok := yqJSON(yq, src, yqExpr)
	if !ok {
		return []string{"could not parse workflow"}
	}
	var view jobsView
	if err := json.Unmarshal(out, &view); err != nil {
		return []string{"could not parse workflow"}
	}
	problems := []string{}
	for _, job := range view.Jobs {
		if job.Uses != nil {
			continue // reusable workflow call — cannot set timeout-minutes
		}
		if job.Timeout == nil {
			problems = append(problems, fmt.Sprintf("job '%s' missing timeout-minutes", job.Name))
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
		emit(0.5, "yq not available in eval environment — cannot inspect jobs.")
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
		emit(1.0, fmt.Sprintf("Every job declares timeout-minutes across %d workflow(s) (%s).", total, origin))
	case ratio >= 0.5:
		emit(0.6, fmt.Sprintf("%d/%d workflow(s) clean. First issue — %s", clean, total, firstViolation))
	default:
		emit(0.2, fmt.Sprintf("Only %d/%d workflow(s) clean. First issue — %s", clean, total, firstViolation))
	}
}
