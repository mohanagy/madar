package main

import (
	"github.com/acme/go-semantic-fixture/internal/handlers"
	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()
	api := chi.NewRouter()
	handler := &handlers.UserHandler{}

	api.Post("/users", handler.CreateUser)
	r.Mount("/chi", api)

	r.Route("/admin", func(admin chi.Router) {
		admin.Get("/users", handler.ListUsers)
	})
}
