package dkfeed

import (
	"bufio"
	"encoding/json"
	"os"
	"testing"
)

// Frames recorded from the live feed, shared with the Node tests.
const recordedFrames = "../../test/fixtures/ws-messages.jsonl"

func TestDecodeRecordedFrames(t *testing.T) {
	file, err := os.Open(recordedFrames)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	var updates, subscribed, priced, removed int
	sc := bufio.NewScanner(file)
	sc.Buffer(nil, 16<<20)
	for n := 1; sc.Scan(); n++ {
		f, u, err := Decode(sc.Bytes())
		if err != nil {
			t.Fatalf("line %d: %v", n, err)
		}
		switch f.Event {
		case "subscribed":
			subscribed++
		case "update":
			updates++
			if u.Metadata.CreatedTime.IsZero() || f.WebsocketPublishTimestamp.IsZero() {
				t.Errorf("line %d: missing DraftKings timestamps", n)
			}
			for _, s := range append(u.Data.Add.Selections, u.Data.Change.Selections...) {
				if s.DisplayOdds != nil && s.DisplayOdds.American != "" {
					priced++
				}
			}
			removed += len(u.Data.Remove.Selections)
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if subscribed != 1 || updates != 43 || priced == 0 || removed == 0 {
		t.Errorf("got %d subscribed, %d updates, %d priced selections, %d removed; want 1, 43, some, some",
			subscribed, updates, priced, removed)
	}
}

func TestIDAcceptsStringsAndNumbers(t *testing.T) {
	var ids []ID
	if err := json.Unmarshal([]byte(`["0ML84695545_1", 84695545, null]`), &ids); err != nil {
		t.Fatal(err)
	}
	if want := []ID{"0ML84695545_1", "84695545", ""}; len(ids) != 3 || ids[0] != want[0] || ids[1] != want[1] || ids[2] != want[2] {
		t.Errorf("got %q, want %q", ids, want)
	}
	if err := json.Unmarshal([]byte(`[{}]`), &ids); err == nil {
		t.Error("an object decoded as an id")
	}
}

// A change that only suspends a market must not come back with an empty name,
// which a consumer applying partial updates would take as clearing it.
func TestMarshalLeavesOutMissingFields(t *testing.T) {
	_, u, err := Decode([]byte(`{"event":"update","data":{"data":{"change":{"markets":[{"id":"1_1","isSuspended":true}]}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(u.Data.Change.Markets[0])
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(b), `{"id":"1_1","isSuspended":true}`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}
