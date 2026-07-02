// Eval: step-summary (scenario-gated)
//
// Only applies WHEN the scenario prompt asks for a job/step summary (keywords:
// "step summary", "job summary", GITHUB_STEP_SUMMARY, "publish/write ... summary",
// "summary ... markdown/report/table"). In that case some run: body must write to
// $GITHUB_STEP_SUMMARY (the file that renders Markdown on the run's summary page).
// If the scenario doesn't ask, the eval auto-passes.
//
//	Scenario: "publish a markdown job summary of the test results"
//	PASS:                                          FAIL:
//	  - run: echo "## Results" >> $GITHUB_STEP_SUMMARY   (nothing writes to
//	                                                      $GITHUB_STEP_SUMMARY)
//
// Score: 1.0 not requested (auto-pass) or requested and satisfied; 0.2 requested
// but absent / no workflow; 0.0 skill not invoked.
package main

import (
	"encoding/json"
	"os"
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

const evalID = "step-summary"
const evalName = "Writes a job summary when the scenario needs it"

var codeBlockRe = regexp.MustCompile("(?s)```(?:ya?ml)?\\n([\\s\\S]*?)```")

func isWorkflow(src string) bool {
	hasJobs := regexp.MustCompile(`(?m)^jobs\s*:`).MatchString(src)
	hasTrigger := regexp.MustCompile(`(?m)^(on|"on"|'on')\s*:`).MatchString(src)
	hasRunsOn := strings.Contains(src, "runs-on")
	return hasJobs && (hasTrigger || hasRunsOn)
}

var compositeRe = regexp.MustCompile(`(?m)^\s*using:\s*['"]?composite`)

func isComposite(src string) bool { return compositeRe.MatchString(src) }

func extractSourceBlocks(text string) []string {
	matches := codeBlockRe.FindAllStringSubmatch(text, -1)
	blocks := make([]string, 0, len(matches))
	for _, m := range matches {
		src := strings.TrimSpace(m[1])
		if isWorkflow(src) || isComposite(src) {
			blocks = append(blocks, src)
		}
	}
	return blocks
}

func collectSourceFiles(workDir string) []string {
	if workDir == "" {
		return nil
	}
	sources := []string{}
	wfRoot := filepath.Join(workDir, ".github", "workflows")
	_ = filepath.Walk(workDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".yml" && ext != ".yaml" {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		src := string(data)
		base := strings.ToLower(info.Name())
		if strings.HasPrefix(path, wfRoot) || base == "action.yml" || base == "action.yaml" {
			if isWorkflow(src) || isComposite(src) {
				sources = append(sources, src)
			}
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

// requestedRe detects a scenario prompt asking for a job/step summary.
var requestedRe = regexp.MustCompile(`(?is)step summary|job summary|github_step_summary|write.*summary|summary.*(markdown|report|table)|publish.*summary`)

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

	if !requestedRe.MatchString(ctx.Scenario.Prompt) {
		emit(1.0, "Auto-pass — scenario does not request a job/step summary.")
		return
	}

	sources := collectSourceFiles(ctx.WorkDir)
	sources = append(sources, extractSourceBlocks(ctx.QualityTranscript)...)
	if len(sources) == 0 {
		emit(0.2, "Scenario requests a job summary but no workflow was produced.")
		return
	}

	for _, src := range sources {
		if strings.Contains(src, "GITHUB_STEP_SUMMARY") {
			emit(1.0, "Scenario requests a job summary and a run: writes to $GITHUB_STEP_SUMMARY.")
			return
		}
	}
	emit(0.2, "Scenario requests a job summary but nothing writes to $GITHUB_STEP_SUMMARY.")
}
