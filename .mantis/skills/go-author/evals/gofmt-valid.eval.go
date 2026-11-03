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

const evalID = "gofmt-valid"
const evalName = "Code passes gofmt"

var goBlockRe = regexp.MustCompile("(?s)```(?:go)?\n([\\s\\S]*?)```")

func extractGoBlocks(text string) []string {
	matches := goBlockRe.FindAllStringSubmatch(text, -1)
	blocks := make([]string, 0, len(matches))
	for _, m := range matches {
		src := strings.TrimSpace(m[1])
		if strings.Contains(src, "func ") || strings.Contains(src, "package ") || strings.Contains(src, "type ") {
			blocks = append(blocks, src)
		}
	}
	return blocks
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

	blocks := extractGoBlocks(ctx.QualityTranscript)
	if len(blocks) == 0 {
		emit(0.5, "No Go code blocks found in response — cannot check formatting.")
		return
	}

	dir, err := os.MkdirTemp("", "gofmt-eval-*")
	if err != nil {
		emit(0.5, "Could not create temp dir for gofmt check.")
		return
	}
	defer os.RemoveAll(dir)

	clean, total := 0, 0
	for i, block := range blocks {
		src := block
		if !strings.HasPrefix(strings.TrimSpace(src), "package ") {
			src = "package main\n\n" + src
		}
		path := filepath.Join(dir, fmt.Sprintf("block_%d.go", i))
		if err := os.WriteFile(path, []byte(src), 0600); err != nil {
			continue
		}
		total++
		out, err := exec.Command("gofmt", "-l", path).Output()
		if err == nil && strings.TrimSpace(string(out)) == "" {
			clean++
		}
	}

	if total == 0 {
		emit(0.5, "No writable Go blocks to check.")
		return
	}

	ratio := float64(clean) / float64(total)
	switch {
	case ratio == 1.0:
		emit(1.0, "All Go code blocks are gofmt-clean.")
	case ratio >= 0.5:
		emit(0.6, fmt.Sprintf("%d/%d code blocks pass gofmt.", clean, total))
	default:
		emit(0.2, fmt.Sprintf("Only %d/%d code blocks pass gofmt — formatting issues detected.", clean, total))
	}
}
