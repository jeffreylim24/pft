package room

import (
	"crypto/rand"
	"encoding/base64"
)

func randomID(nBytes int) string {
	b := make([]byte, nBytes)
	rand.Read(b) // crypto/rand.Read never returns an error
	return base64.RawURLEncoding.EncodeToString(b)
}

// NewRoomID returns 128 random bits as 22 base64url characters.
func NewRoomID() string { return randomID(16) }

// NewParticipantID returns 64 random bits as 11 base64url characters.
func NewParticipantID() string { return randomID(8) }

// NewResumeToken returns 128 random bits as 22 base64url characters.
func NewResumeToken() string { return randomID(16) }
