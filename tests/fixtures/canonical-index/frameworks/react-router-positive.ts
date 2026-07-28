import { createBrowserRouter } from 'react-router-dom'
import { action, loader } from './react-router-handlers.js'

export const browserRouter = createBrowserRouter([
  { path: '/account', loader, action },
])
