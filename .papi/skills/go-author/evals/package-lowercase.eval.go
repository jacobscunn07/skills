package main

import (
	"encoding/json"
	"os"
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
}

type evalResult struct {
	EvalID    string  `json:"evalId"`
	Name      string  `json:"name"`
	Score     float64 `json:"score"`
	Reasoning string  `json:"reasoning"`
}

const evalID = "package-lowercase"
const evalName = "Package names are lowercase single-word"

var (
	codeBlockRe = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	packageRe   = regexp.MustCompile(`(?m)^package\s+(\w+)`)
	// Invalid: contains uppercase or underscore
	invalidPkgRe = regexp.MustCompile(`[A-Z_]`)
)

func extractCodeBlocks(text string) []string {
	matches := codeBlockRe.FindAllStringSubmatch(text, -1)
	blocks := make([]string, 0, len(matches))
	for _, m := range matches {
		blocks = append(blocks, m[1])
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

	allCode := strings.Join(extractCodeBlocks(ctx.QualityTranscript), "\n")
	pkgs := packageRe.FindAllStringSubmatch(allCode, -1)

	if len(pkgs) == 0 {
		emit(0.5, "No package declarations found — cannot verify naming.")
		return
	}

	violations := []string{}
	for _, m := range pkgs {
		name := m[1]
		if name == "main" {
			continue // main is always valid
		}
		if invalidPkgRe.MatchString(name) {
			violations = append(violations, name)
		}
	}

	if len(violations) == 0 {
		emit(1.0, "All package names are lowercase with no underscores.")
		return
	}

	emit(0.1, "Package names must be lowercase single-word with no underscores or MixedCaps (found: "+strings.Join(violations, ", ")+").")
}
