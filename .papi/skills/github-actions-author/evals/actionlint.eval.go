// Eval: actionlint
//
// Lints every produced workflow with `actionlint`, catching problems a plain
// YAML parse misses: bad expression syntax, unknown runner labels, invalid
// event/permission keys, misused contexts, shellcheck issues in run: blocks.
// Each workflow (from .github/workflows or ```yaml blocks) is written into a
// temp .github/workflows/ tree and linted individually.
//
//	PASS:                                  FAIL (bad === in expression):
//	  steps:                                 steps:
//	    - run: echo hi                         - run: echo hi
//	      if: ${{ github.ref == 'x' }}           if: ${{ github.ref === 'x' }}
//
// Score: 1.0 all pass, 0.6 majority, 0.2 mostly failing, 0.5 nothing to lint or
// actionlint unavailable, 0.0 skill not invoked. Failures cite the first error.
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

const evalID = "actionlint"
const evalName = "Workflows pass actionlint"

// Matches ```yaml / ```yml / ``` fenced blocks and captures their body.
var codeBlockRe = regexp.MustCompile("(?s)```(?:ya?ml)?\\n([\\s\\S]*?)```")

// A block looks like a GitHub Actions workflow if it declares jobs plus a
// trigger or a runner — enough to avoid linting incidental YAML snippets.
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

// collectWorkflowFiles finds workflow YAML written to disk under
// .github/workflows (the only path GitHub Actions actually reads).
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

// firstError returns the first non-empty line of actionlint output with the
// temp file path stripped, leaving a readable "line:col: message". actionlint
// prints the path relative to cwd, so match on the base filename.
func firstError(out, path string) string {
	marker := filepath.Base(path) + ":"
	for _, line := range strings.Split(out, "\n") {
		s := strings.TrimSpace(line)
		if s == "" {
			continue
		}
		if idx := strings.Index(s, marker); idx >= 0 {
			return s[idx+len(marker):]
		}
		return s
	}
	return "unknown error"
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

	actionlint, err := exec.LookPath("actionlint")
	if err != nil {
		emit(0.5, "actionlint not available in eval environment — cannot lint workflows.")
		return
	}

	// Prefer workflow files on disk; fall back to fenced blocks in the response.
	sources := collectWorkflowFiles(ctx.WorkDir)
	fromDisk := len(sources)
	sources = append(sources, extractWorkflowBlocks(ctx.QualityTranscript)...)

	if len(sources) == 0 {
		emit(0.5, "No GitHub Actions workflow YAML found — nothing to lint.")
		return
	}

	// actionlint keys some checks off the .github/workflows/ path, so write
	// each source into that structure inside a temp dir before linting.
	dir, err := os.MkdirTemp("", "actionlint-eval-*")
	if err != nil {
		emit(0.5, "Could not create temp dir for actionlint check.")
		return
	}
	defer os.RemoveAll(dir)
	wfDir := filepath.Join(dir, ".github", "workflows")
	if err := os.MkdirAll(wfDir, 0700); err != nil {
		emit(0.5, "Could not create workflow dir for actionlint check.")
		return
	}

	clean, total := 0, 0
	failures := []string{}
	for i, src := range sources {
		path := filepath.Join(wfDir, fmt.Sprintf("wf_%d.yml", i))
		if err := os.WriteFile(path, []byte(src), 0600); err != nil {
			continue
		}
		total++
		out, err := exec.Command(actionlint, "-no-color", path).CombinedOutput()
		if err == nil {
			clean++
		} else {
			failures = append(failures, fmt.Sprintf("workflow %d: %s", i+1, firstError(string(out), path)))
		}
	}

	if total == 0 {
		emit(0.5, "No writable workflow files to lint.")
		return
	}

	origin := fmt.Sprintf("%d from disk, %d from response", fromDisk, total-fromDisk)
	ratio := float64(clean) / float64(total)
	switch {
	case ratio == 1.0:
		emit(1.0, fmt.Sprintf("All %d workflow(s) pass actionlint (%s).", total, origin))
	case ratio >= 0.5:
		emit(0.6, fmt.Sprintf("%d/%d workflow(s) pass actionlint. First issue — %s", clean, total, failures[0]))
	default:
		emit(0.2, fmt.Sprintf("Only %d/%d workflow(s) pass actionlint. First issue — %s", clean, total, failures[0]))
	}
}
