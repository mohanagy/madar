package audit

type LoginAudit struct {
	Events []string
}

func NewLoginAudit() *LoginAudit {
	return &LoginAudit{Events: []string{}}
}

func (a *LoginAudit) RecordLoginSession(userID string, sessionID string) {
	a.Events = append(a.Events, userID+":"+sessionID)
}
