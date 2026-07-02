// Eval: no-write-all
//
// Bans the blanket `permissions: write-all` shorthand anywhere — top level or on
// any job — since it grants the maximally broad token. Granular write scopes
// inside a permissions map are intentionally allowed; only the shorthand fails.
//
//	PASS (granular):             PASS (read-all):        FAIL:
//	  permissions:                 permissions: read-all   permissions: write-all
//	    contents: write
//	    packages: write
//
// Score: 1.0 all clean, 0.6 majority, 0.2 mostly failing, 0.5 nothing to check or
// yq unavailable, 0.0 skill not invoked. Complements permissions-declared.
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

const evalID = "no-write-all"
const evalName = "Workflows do not grant write-all permissions"

// Matches ```yaml / ```yml / ``` fenced blocks and captures their body.
var codeBlockRe = regexp.MustCompile("(?s)```(?:ya?ml)?\\n([\\s\\S]*?)```")

// A block looks like a GitHub Actions workflow if it declares jobs plus a
// trigger or a runner — enough to avoid inspecting incidental YAML snippets.
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

// permsView is the shape yq projects out of each workflow: the top-level
// permissions value and each job's permissions value.
type permsView struct {
	Top  interface{} `json:"top"`
	Jobs []struct {
		Name  string      `json:"name"`
		Perms interface{} `json:"perms"`
	} `json:"jobs"`
}

// grantsWriteAll reports whether a permissions value is the blanket write-all
// shorthand. Granular write scopes inside a map are intentionally not flagged.
func grantsWriteAll(v interface{}) bool {
	s, ok := v.(string)
	return ok && s == "write-all"
}

const yqExpr = `{"top": .permissions, "jobs": (.jobs // {} | to_entries | map({"name": .key, "perms": .value.permissions}))}`

// violations returns the write-all grants in a single workflow source.
// A parse failure is reported as a violation rather than silently passing.
func violations(yq, src string) []string {
	cmd := exec.Command(yq, "-o=json", "-I=0", yqExpr)
	cmd.Stdin = strings.NewReader(src)
	out, err := cmd.Output()
	if err != nil {
		return []string{"could not parse workflow"}
	}

	var view permsView
	if err := json.Unmarshal(out, &view); err != nil {
		return []string{"could not parse workflow"}
	}

	problems := []string{}
	if grantsWriteAll(view.Top) {
		problems = append(problems, "top-level permissions grants write-all")
	}
	for _, job := range view.Jobs {
		if grantsWriteAll(job.Perms) {
			problems = append(problems, fmt.Sprintf("job '%s' permissions grants write-all", job.Name))
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
		emit(0.5, "yq not available in eval environment — cannot inspect permissions.")
		return
	}

	// Prefer workflow files on disk; fall back to fenced blocks in the response.
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
		emit(1.0, fmt.Sprintf("No workflow grants write-all across %d workflow(s) (%s).", total, origin))
	case ratio >= 0.5:
		emit(0.6, fmt.Sprintf("%d/%d workflow(s) clean. First issue — %s", clean, total, firstViolation))
	default:
		emit(0.2, fmt.Sprintf("Only %d/%d workflow(s) clean. First issue — %s", clean, total, firstViolation))
	}
}
