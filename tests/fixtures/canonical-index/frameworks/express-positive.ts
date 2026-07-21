import express from 'express'
import { expressHandler } from './express-handler.js'

export const expressApp = express()
expressApp.get('/users', expressHandler)
