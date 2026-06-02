from fastapi import FastAPI

from app.routes.session_routes import router

app = FastAPI(title="madar-python-service")
app.include_router(router)
