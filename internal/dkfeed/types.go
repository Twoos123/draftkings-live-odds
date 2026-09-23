// Package dkfeed is a client for DraftKings' public push feed: one websocket,
// one JSON-RPC subscription, frames decoded into typed structs with DraftKings'
// own timestamps for latency.
package dkfeed

import (
	"encoding/json"
	"time"
)

// Frame is the envelope of every push-feed message.
type Frame struct {
	ID    string          `json:"id"`    // the subscription id
	Event string          `json:"event"` // "subscribed", "update", "error", ...
	Data  json.RawMessage `json:"data"`  // an Update when Event is "update"
	// When DraftKings' websocket server sent the frame, on its clock.
	WebsocketPublishTimestamp time.Time `json:"websocketPublishTimestamp"`
}

// Update is the Data of an "update" frame. Fields a message leaves out stay
// zero, and are left out again when an Update is marshaled back to JSON.
type Update struct {
	Data     Delta      `json:"data"`
	Metadata UpdateMeta `json:"metadata"`
}

type Delta struct {
	Add    Entities `json:"add"`
	Change Entities `json:"change"` // partial objects: the id plus what changed
	Remove Removed  `json:"remove"`
}

type Entities struct {
	Events     []Event     `json:"events"`
	Markets    []Market    `json:"markets"`
	Selections []Selection `json:"selections"`
}

type Removed struct {
	Events     []ID `json:"events"`
	Markets    []ID `json:"markets"`
	Selections []ID `json:"selections"`
}

// UpdateMeta holds DraftKings' timestamps for an update.
type UpdateMeta struct {
	CreatedTime   time.Time `json:"createdTime,omitzero"`   // DK's trading system created the change
	ReceivedTime  time.Time `json:"receivedTime,omitzero"`  // DK's feed received it
	PublishedTime time.Time `json:"publishedTime,omitzero"` // DK published it to its socket servers
}

type Event struct {
	ID             ID            `json:"id"`
	Name           string        `json:"name,omitzero"`
	StartEventDate time.Time     `json:"startEventDate,omitzero"`
	Status         string        `json:"status,omitzero"` // e.g. "NOT_STARTED"
	Participants   []Participant `json:"participants,omitzero"`
}

type Participant struct {
	ID        ID     `json:"id"`
	Name      string `json:"name,omitzero"`
	VenueRole string `json:"venueRole,omitzero"` // "Home" or "Away"
}

type Market struct {
	ID          ID       `json:"id"`
	EventID     ID       `json:"eventId,omitzero"`
	Name        string   `json:"name,omitzero"`        // "Moneyline", "Spread", "Total", ...
	IsSuspended *bool    `json:"isSuspended,omitzero"` // nil when a change doesn't touch it
	Tags        []string `json:"tags,omitzero"`
}

type Selection struct {
	ID          ID           `json:"id"`
	MarketID    ID           `json:"marketId,omitzero"`
	Label       string       `json:"label,omitzero"`
	DisplayOdds *DisplayOdds `json:"displayOdds,omitzero"`
	TrueOdds    float64      `json:"trueOdds,omitzero"`
	Points      *float64     `json:"points,omitzero"` // spread/total line; nil for moneyline
	OutcomeType string       `json:"outcomeType,omitzero"`
	// Set when a line moves: DK issues a new selection id and points at the old one.
	ReplacedSelectionID ID `json:"replacedSelectionId,omitzero"`
}

type DisplayOdds struct {
	American string `json:"american,omitzero"` // minus is U+2212, e.g. "−110"
	Decimal  string `json:"decimal,omitzero"`
}

// ID is a DraftKings id. The feed sends most as strings, some as numbers.
type ID string
