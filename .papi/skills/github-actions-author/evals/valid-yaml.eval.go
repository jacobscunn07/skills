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

const evalID = "valid-yaml"
const evalName = "Workflow files are valid YAML"

// Matches ```yaml / ```yml / ``` fenced blocks and captures their body.
var codeBlockRe = regexp.MustCompile("(?s)```(?:ya?ml)?\\n([\\s\\S]*?)```")

// A block looks like a GitHub Actions workflow if it declares jobs plus a
// trigger or a runner — enough to avoid flagging incidental YAML snippets.
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

// yamlValidator returns a command that validates YAML passed on stdin,
// exiting non-zero on a parse error. Prefers yq, falls back to python3.
func yamlValidator() (func(src string) error, bool) {
	if path, err := exec.LookPath("yq"); err == nil {
		return func(src string) error {
			cmd := exec.Command(path, "-e", ".")
			cmd.Stdin = strings.NewReader(src)
			return cmd.Run()
		}, true
	}
	if path, err := exec.LookPath("python3"); err == nil {
		// Only usable if PyYAML is importable.
		if exec.Command(path, "-c", "import yaml").Run() == nil {
			return func(src string) error {
				cmd := exec.Command(path, "-c", "import sys,yaml; yaml.safe_load(sys.stdin.read())")
				cmd.Stdin = strings.NewReader(src)
				return cmd.Run()
			}, true
		}
	}
	return nil, false
}

func emit(score float64, reasoning string) {
	json.NewEncoder(os.Stdout).Encode(evalResult{
		EvalID:    evalID,
		Name:      evalName,
		Score:     score,
		Reasoning: reasoning,
	})
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

	// Prefer workflow files on disk; fall back to fenced blocks in the response.
	sources := collectWorkflowFiles(ctx.WorkDir)
	fromDisk := len(sources)
	sources = append(sources, extractWorkflowBlocks(ctx.QualityTranscript)...)

	if len(sources) == 0 {
		emit(0.5, "No GitHub Actions workflow YAML found — cannot verify validity.")
		return
	}

	validate, ok := yamlValidator()
	if !ok {
		emit(0.5, "No YAML validator (yq / python3+PyYAML) available in eval environment.")
		return
	}

	valid, total := 0, 0
	failures := []string{}
	for i, src := range sources {
		total++
		if err := validate(src); err == nil {
			valid++
		} else {
			failures = append(failures, fmt.Sprintf("workflow %d", i+1))
		}
	}

	origin := fmt.Sprintf("%d from disk, %d from response", fromDisk, total-fromDisk)
	ratio := float64(valid) / float64(total)
	switch {
	case ratio == 1.0:
		emit(1.0, fmt.Sprintf("All %d workflow YAML document(s) parse cleanly (%s).", total, origin))
	case ratio >= 0.5:
		emit(0.6, fmt.Sprintf("%d/%d workflow YAML document(s) valid; invalid: %s.", valid, total, strings.Join(failures, ", ")))
	default:
		emit(0.2, fmt.Sprintf("Only %d/%d workflow YAML document(s) valid — invalid: %s.", valid, total, strings.Join(failures, ", ")))
	}
}
