package main

import (
	"net/http"

	"github.com/acme/go-semantic-fixture/internal/handlers"
	"github.com/gin-gonic/gin"
)

func main() {
	mux := http.NewServeMux()
	httpHandler := &handlers.UserHandler{}
	mux.HandleFunc("/users", httpHandler.ListUsers)

	router := gin.Default()
	api := router.Group("/api")
	ginHandler := &handlers.UserHandler{}
	api.POST("/users", ginHandler.CreateUser)
}
