// Express server with named routes — the canonical legacy detector target.

import express, { Router } from 'express'

export const app = express()
export const usersRouter = Router()

export function listUsers(): void {
  // Returns all users from the DB.
}

export function getUserById(): void {
  // Returns a single user by id.
}

export function createUser(): void {
  // Persists a new user.
}

export function authMiddleware(): void {
  // Verifies bearer token from Authorization header.
}

usersRouter.get('/', listUsers)
usersRouter.get('/:id', getUserById)
usersRouter.post('/', createUser)
app.use('/api/users', usersRouter)
app.use(authMiddleware)
