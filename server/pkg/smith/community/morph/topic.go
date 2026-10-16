package morph

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// RefusalError is a submission morph did not take: its answer, and whether
// it was a refusal (400) rather than a failure.
type RefusalError struct {
	Message string
	Native  json.RawMessage
	Refused bool
}

func (e *RefusalError) Error() string { return e.Message }

// OpenTopic is the topic a session runs in: the one to resume, checked to
// exist, or a new empty one (`POST /topics`).
func OpenTopic(ctx context.Context, client *Client, resume string) (string, error) {
	if resume != "" {
		reply, err := client.Call(ctx, "GET", "/topics/"+urlEscape(resume), nil)
		if err != nil {
			return "", err
		}
		if reply.Status == 404 {
			return "", fmt.Errorf("morph has no topic %s to resume", resume)
		}
		if reply.Status != 200 {
			return "", fmt.Errorf("morph GET /topics/%s answered %d: %s", resume, reply.Status, ReplyMessage(reply))
		}
		return resume, nil
	}
	reply, err := client.Call(ctx, "POST", "/topics", map[string]any{})
	if err != nil {
		return "", err
	}
	if reply.Status == 405 {
		return "", fmt.Errorf("This morph Console cannot create an empty topic (POST /topics); update morph to a version that has it")
	}
	if reply.Status != 201 && reply.Status != 200 {
		return "", fmt.Errorf("morph POST /topics answered %d: %s", reply.Status, ReplyMessage(reply))
	}
	id, _ := jsonx.ParseRecord(reply.Body)["id"].(string)
	if id == "" {
		return "", errNoTopicID
	}
	return id, nil
}

func profileNames(catalog json.RawMessage) []string {
	record := jsonx.ParseRecord(catalog)
	var names []string
	for _, profile := range append([]jsonx.Record{jsonx.AsRecord(record["default"])}, jsonx.AsRecordList(record["items"])...) {
		if name, ok := profile["name"].(string); ok {
			names = append(names, name)
		}
	}
	return names
}

// CheckProfile refuses to open on an LLM profile Console does not have.
func CheckProfile(ctx context.Context, client *Client, model string) error {
	catalog, err := client.Expect(ctx, "GET", "/llm/profiles", nil)
	if err != nil {
		return err
	}
	names := profileNames(catalog)
	for _, name := range names {
		if name == model {
			return nil
		}
	}
	return fmt.Errorf("morph has no LLM profile %s (configured: %s)", model, strings.Join(names, ", "))
}

// SubmitTask posts a task into the topic; a non-200 answer or one without a task id is a RefusalError.
func SubmitTask(ctx context.Context, client *Client, body map[string]any) (jsonx.Record, json.RawMessage, error) {
	reply, err := client.Call(ctx, "POST", "/tasks", body)
	if err != nil {
		return nil, nil, err
	}
	answer := jsonx.ParseRecord(reply.Body)
	if _, ok := answer["id"].(string); reply.Status != 200 || answer == nil || !ok {
		return nil, nil, &RefusalError{Message: ReplyMessage(reply), Native: reply.Body, Refused: reply.Status == 400}
	}
	return answer, reply.Body, nil
}

// StopTask: accepted when Console found running work for the task.
func StopTask(ctx context.Context, client *Client, taskID string) (oar.ResponseBody, error) {
	reply, err := client.Call(ctx, "POST", "/tasks/"+urlEscape(taskID)+"/stop", nil)
	if err != nil {
		return oar.ResponseBody{}, err
	}
	if reply.Status != 200 {
		body := oar.Rejected(oar.CodeRuntimeRefused, ReplyMessage(reply))
		body.Native = reply.Body
		return body, nil
	}
	if jsonx.ParseRecord(reply.Body)["found"] == true {
		return oar.ResponseBody{Kind: oar.ResponseAccepted, Native: reply.Body}, nil
	}
	body := oar.Rejected(oar.CodeNoActiveTurn, "morph found no running work for the task")
	body.Native = reply.Body
	return body, nil
}

// CarrierTask is the task whose turn carries a submission: the run it steered into, or its own.
func CarrierTask(answer jsonx.Record) string {
	if target, ok := answer["steer_target_task_id"].(string); ok && target != "" {
		return target
	}
	id, _ := answer["id"].(string)
	return id
}
