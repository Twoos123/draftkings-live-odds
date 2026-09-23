package dkfeed

import "encoding/json"

// Decode parses one push-feed frame. upd is non-nil for "update" frames.
func Decode(raw []byte) (f Frame, upd *Update, err error) {
	if err := json.Unmarshal(raw, &f); err != nil {
		return f, nil, err
	}
	if f.Event != "update" {
		return f, nil, nil
	}
	upd = new(Update)
	if err := json.Unmarshal(f.Data, upd); err != nil {
		return f, nil, err
	}
	return f, upd, nil
}

// UnmarshalJSON accepts an id sent as either a string or a number.
func (id *ID) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*id = ID(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*id = ID(n)
	return nil
}
