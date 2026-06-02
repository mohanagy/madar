package main

import (
	"log"
	"net/http"

	"example.com/madar-go-service/internal/audit"
	"example.com/madar-go-service/internal/httpapi"
	"example.com/madar-go-service/internal/repository"
	"example.com/madar-go-service/internal/service"
)

func main() {
	repo := repository.NewSessionRepository()
	loginAudit := audit.NewLoginAudit()
	sessionService := service.NewSessionService(repo, loginAudit)
	sessionHandler := httpapi.NewSessionHandler(sessionService)

	mux := http.NewServeMux()
	sessionHandler.Register(mux)

	log.Fatal(http.ListenAndServe(":8080", mux))
}
