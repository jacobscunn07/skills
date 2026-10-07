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

const evalID = "interface-er-naming"
const evalName = "Single-method interfaces use -er/-or suffix"

var (
	codeBlockRe = regexp.MustCompile("(?s)```[\\w]*\n([\\s\\S]*?)```")
	// Capture interface name and body to count methods
	interfaceRe = regexp.MustCompile(`(?s)type\s+(\w+)\s+interface\s*\{([^}]*)\}`)
	// A method line inside an interface body: identifier followed by (
	methodLineRe = regexp.MustCompile(`(?m)^\s*\w+\s*\(`)
	// -er / -or / -ar suffix (covers Reader, Writer, Stringer, Validator, etc.)
	erSuffixRe = regexp.MustCompile(`(?:er|or|ar)$`)
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
	ifaces := interfaceRe.FindAllStringSubmatch(allCode, -1)

	if len(ifaces) == 0 {
		emit(0.5, "No interface definitions found — naming convention check not applicable.")
		return
	}

	total, compliant, violations := 0, 0, []string{}
	for _, m := range ifaces {
		name, body := m[1], m[2]
		methods := methodLineRe.FindAllString(body, -1)
		if len(methods) != 1 {
			continue // only check single-method interfaces
		}
		total++
		if erSuffixRe.MatchString(name) {
			compliant++
		} else {
			violations = append(violations, name)
		}
	}

	if total == 0 {
		emit(0.5, "No single-method interfaces found — -er suffix convention not applicable.")
		return
	}

	if len(violations) == 0 {
		emit(1.0, "All single-method interfaces follow the -er/-or suffix convention.")
		return
	}

	emit(0.2, "Single-method interfaces without -er suffix: "+strings.Join(violations, ", ")+".")
}
