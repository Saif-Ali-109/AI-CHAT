import os
import json
import time
from collections import deque
from datetime import datetime, timezone
from typing import List, Dict

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from sqlmodel import Session, select
from starlette.requests import Request
from starlette.middleware.sessions import SessionMiddleware

from app.database.database import engine, init_db, get_session
from app.models.models import User, UsageLog, Conversation, Message
from app.auth.auth import oauth, create_access_token, verify_token
from app.ai_service.ai_service import ai_service

from contextlib import asynccontextmanager

RATE_LIMIT_MESSAGES = 30
RATE_LIMIT_WINDOW = 60
_rate_limit_store: Dict[int, deque] = {}

def is_rate_limited(user_id: int) -> bool:
    now = time.time()
    if user_id not in _rate_limit_store:
        _rate_limit_store[user_id] = deque()
    window = _rate_limit_store[user_id]
    while window and window[0] < now - RATE_LIMIT_WINDOW:
        window.popleft()
    if len(window) >= RATE_LIMIT_MESSAGES:
        return True
    window.append(now)
    return False

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(title="AI Chat App API", lifespan=lifespan)

@app.get("/")
async def root():
    return {"status": "ok", "service": "AI Chat Backend"}

@app.get("/health")
async def health():
    return {"status": "healthy"}

# MANDATORY: Explicit origins for CORS with credentials
# Allowing all local variations for maximum compatibility
origins = [
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.add_middleware(SessionMiddleware, secret_key=os.getenv("SECRET_KEY", "your-secret-key"))

def get_token_from_header(request: Request):
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return auth_header.split(" ")[1]
    return request.query_params.get("token")

def get_backend_url(request: Request):
    backend_url = os.getenv("BACKEND_URL", "").rstrip("/")
    if backend_url:
        return backend_url
    return f"{request.url.scheme}://{request.url.netloc}"

def get_frontend_url():
    frontend_url = os.getenv("FRONTEND_URL", "").rstrip("/")
    if frontend_url:
        if not frontend_url.startswith("http://") and not frontend_url.startswith("https://"):
            frontend_url = "https://" + frontend_url
        return frontend_url
    return "http://127.0.0.1:3000"

@app.get("/auth/login")
async def login(request: Request):
    redirect_uri = get_backend_url(request) + "/auth/callback"
    return await oauth.google.authorize_redirect(request, redirect_uri)

@app.get("/auth/callback")
async def auth_callback(request: Request, session: Session = Depends(get_session)):
    token = await oauth.google.authorize_access_token(request)
    user_info = token.get('userinfo')
    if not user_info:
        raise HTTPException(status_code=400, detail="Failed to fetch user info from Google")
    
    user = session.exec(select(User).where(User.google_id == user_info['sub'])).first()
    if not user:
        user = User(google_id=user_info['sub'], email=user_info['email'], name=user_info['name'], picture=user_info.get('picture'))
        session.add(user)
    else:
        user.last_login = datetime.now(timezone.utc)
        user.last_active = datetime.now(timezone.utc)
    
    session.commit()
    session.refresh(user)
    
    access_token = create_access_token(data={"sub": user.email, "id": user.id})
    return RedirectResponse(url=f"{get_frontend_url()}/auth/success?token={access_token}")

@app.get("/user/stats")
async def get_user_stats(request: Request, session: Session = Depends(get_session)):
    token = get_token_from_header(request)
    payload = verify_token(token)
    if not payload: raise HTTPException(status_code=401)
    user = session.get(User, payload["id"])
    return {
        "name": user.name, "email": user.email, "picture": user.picture,
        "last_active": user.last_active, "total_requests": user.total_requests,
        "total_tokens_used": user.total_tokens_used
    }

@app.get("/conversations")
async def get_conversations(request: Request, session: Session = Depends(get_session)):
    token = get_token_from_header(request)
    payload = verify_token(token)
    if not payload: raise HTTPException(status_code=401)
    return session.exec(select(Conversation).where(
        Conversation.user_id == payload["id"],
        Conversation.is_deleted == False
    ).order_by(Conversation.updated_at.desc())).all()

@app.get("/conversations/{conv_id}/messages")
async def get_messages(conv_id: int, request: Request, session: Session = Depends(get_session)):
    token = get_token_from_header(request)
    payload = verify_token(token)
    if not payload: raise HTTPException(status_code=401)
    conv = session.get(Conversation, conv_id)
    if not conv or conv.user_id != payload["id"] or conv.is_deleted: raise HTTPException(status_code=403)
    return session.exec(select(Message).where(Message.conversation_id == conv_id).order_by(Message.timestamp.asc())).all()

@app.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: int, request: Request, session: Session = Depends(get_session)):
    token = get_token_from_header(request)
    payload = verify_token(token)
    if not payload: raise HTTPException(status_code=401)
    conv = session.get(Conversation, conv_id)
    if not conv or conv.user_id != payload["id"]: raise HTTPException(status_code=403)
    
    conv.is_deleted = True
    session.add(conv)
    session.commit()
    return Response(status_code=204)

@app.websocket("/chat")
async def websocket_endpoint(websocket: WebSocket, session: Session = Depends(get_session)):
    await websocket.accept()
    try:
        initial_msg = await websocket.receive_text()
        auth_data = json.loads(initial_msg)
        token = auth_data.get("token")
        provider = auth_data.get("provider", "gemini")
        conv_id = auth_data.get("conversation_id")
        
        payload = verify_token(token)
        if not payload:
            await websocket.send_text(json.dumps({"error": "Unauthorized"}))
            await websocket.close()
            return
        
        user = session.get(User, payload["id"])
        if not user: return

        if conv_id:
            conversation = session.get(Conversation, conv_id)
            if not conversation or conversation.user_id != user.id or conversation.is_deleted:
                conv_id = None
        
        if not conv_id:
            conversation = Conversation(user_id=user.id)
            session.add(conversation)
            session.commit()
            session.refresh(conversation)
            conv_id = conversation.id
            await websocket.send_text(json.dumps({"type": "conversation_created", "id": conv_id}))
        else:
            conversation = session.get(Conversation, conv_id)

        while True:
            data = await websocket.receive_text()
            message_data = json.loads(data)
            user_message = message_data.get("message")
            if not user_message: continue

            if is_rate_limited(user.id):
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "error": "Rate limit exceeded. You can send up to 30 messages per minute."
                }))
                continue

            db_user_msg = Message(conversation_id=conv_id, role="user", content=user_message)
            session.add(db_user_msg)
            
            history_objs = session.exec(select(Message).where(Message.conversation_id == conv_id).order_by(Message.timestamp.asc())).all()
            history = [{"role": m.role, "content": m.content} for m in history_objs[:-1]]

            user.last_active = datetime.now(timezone.utc)
            user.total_requests += 1
            session.add(user)
            session.commit()

            full_response = ""
            async for chunk in ai_service.generate_response(provider, user_message, history):
                full_response += chunk
                await websocket.send_text(json.dumps({"type": "chunk", "content": chunk}))
            
            db_assistant_msg = Message(conversation_id=conv_id, role="assistant", content=full_response)
            session.add(db_assistant_msg)
            
            if conversation.title == "New Chat":
                conversation.title = user_message[:30] + ("..." if len(user_message) > 30 else "")
            
            conversation.updated_at = datetime.now(timezone.utc)
            session.add(conversation)
            await websocket.send_text(json.dumps({"type": "done"}))

            tokens_used = len(full_response) // 4 + len(user_message) // 4
            user.total_tokens_used += tokens_used
            log = UsageLog(user_id=user.id, tokens_used=tokens_used, provider=provider, model=os.getenv("GEMINI_MODEL_NAME", "gemini-2.5-flash"))
            session.add(log)
            session.commit()

    except WebSocketDisconnect: pass
    except Exception as e: await websocket.send_text(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
