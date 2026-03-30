import os
import time
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2' 
os.environ['TF_ENABLE_ONEDNN_OPTS'] = '0'

from fastapi import FastAPI, File, UploadFile, HTTPException,Depends,status,Request
from typing import Optional
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
import uvicorn
import numpy as np
from PIL import Image
import io
import tensorflow as tf
from sqlalchemy.orm import Session

import models as models
from database import get_db,engine
from cloud import upload_image
from auth import get_password_hash,verify_password,create_access_token,verify_token
from schemas import UserBase,History,Token
# from checkanimal import get_embedding,is_same_animal



#Chon model
MODEL_DIR = 'modelv2'
#Dat ten class
CLASS_NAMES = ['Mèo (Cat)', 'Gà (Chicken)', 'Bò (Cow)', 'Chó (Dog)', 'Ngựa (Horse)']
IMG_SIZE = 224

# 1. Định nghĩa hàm khởi tạo DB bất đồng bộ
async def init_db():
    async with engine.begin() as conn:
        # Lệnh này giúp chạy hàm create_all (vốn là đồng bộ) 
        # trong môi trường bất đồng bộ của aiosqlite
        await conn.run_sync(models.Base.metadata.create_all)

# 2. Gọi hàm này khi FastAPI khởi động
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Khởi tạo bảng khi server bắt đầu chạy
    await init_db()
    yield

app = FastAPI(lifespan=lifespan)
#cho phep goi api
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
allowed_types = ['image/jpeg', 'image/png', 'image/jpg']
def validate_image(file: UploadFile):
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f'File không đúng định dạng'
        )
    if file.size > 5 * 1024 * 1024:
        raise HTTPException(
            status_code=400,
            detail=f'File quá lớn'
        )

serving_fn = None
if os.path.exists(MODEL_DIR):
    try:
        loaded_model = tf.saved_model.load(MODEL_DIR)
        serving_fn = loaded_model.signatures['serving_default']
        print("TẢI MODEL THÀNH CÔNG!")
    except Exception as e:
        print("\nLỖI TẢI MODEL:")
        print(str(e))
else:
    print(f"\nLỖI: Không tìm thấy thư mục '{MODEL_DIR}'")

def preprocess_image(image: Image.Image, target_size: tuple):
    if image.mode != "RGB":
        image = image.convert("RGB")
    image = image.resize(target_size)
    img_array = tf.keras.preprocessing.image.img_to_array(image)
    img_array = (img_array / 127.5) - 1.0
    img_array = np.expand_dims(img_array, axis=0)
    return img_array

@app.exception_handler(Exception)
async def unicorn_exception_handler(request: Request, exc: Exception):
    status_code = getattr(exc, 'status_code', 500)
    detail = getattr(exc, 'detail', str(exc))
    
    return JSONResponse(
        status_code = status_code,
        content ={
            'status':'error',
            'message': 'Something went wrong',
            'detail': detail
        }
    )

@app.middleware("http")
async def db_session_middleware(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    duration = time.time() - start_time
    response.headers["X-Process-Time"] = str(duration)
    return response

@app.post("/register",response_model=UserBase,status_code=status.HTTP_201_CREATED)
async def register(request: Request,user: UserBase,db: Session = Depends(get_db)):
    db_user = db.query(models.User).filter(models.User.username == user.username).first()
    if db_user:
        raise HTTPException(
            status_code = status.HTTP_400_BAD_REQUEST,
            detail = 'Tài khoản đã tồn tại'
        )
    hashed_password = get_password_hash(user.password)
    new_user = models.User(
        username = user.username,
        password = hashed_password
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user

@app.post("/login",response_model=Token,status_code=status.HTTP_200_OK)
async def login(request: Request,user: UserBase,db: Session = Depends(get_db)):
    user_db = db.query(models.User).filter(models.User.username == user.username).first()
    if not user_db or not verify_password(user.password, user_db.password):
        raise HTTPException(
            status_code = status.HTTP_400_BAD_REQUEST,
            detail = 'Kiểm tra lại tài khoản hoặc mật khẩu'
        )
    verify_token(str(user_db.id))
    access_token = create_access_token(data={"sub": str(user_db.id)})
    return {"status": "login successfully", "access_token": access_token, "token_type": "bearer"}


@app.post("/predict",response_model=dict,status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def predict(request: Request,file: UploadFile = File(...),db: Session = Depends(get_db),current_user_id: int = Depends(verify_token)):
    if not serving_fn:
        raise HTTPException(status_code=500, detail="Model chưa tải được")

    try:
        validate_image(file)
        contents = file.file.read()
        image = Image.open(io.BytesIO(contents))
        processed_image = preprocess_image(image, (IMG_SIZE, IMG_SIZE))
        input_tensor = tf.constant(processed_image, dtype=tf.float32)
        predictions_dict = serving_fn(input_tensor)
        predictions = list(predictions_dict.values())[0]
        probs = predictions.numpy()[0]
        top_indices = np.argsort(probs)[::-1]
        # best_index = top_indices[0]
        # THRESHOLD = 0.8
        # best_prob = probs[best_index]

        # # Nếu độ tin cậy thấp thì không trả kết quả
        # if best_prob < THRESHOLD:
        #     return {
        #         "success": False,
        #         "message": "Độ tin cậy quá thấp, không thể dự đoán"
        #     }
        results = []
        results = []
        for i in top_indices:
            percentage = float(probs[i]) * 100
            results.append({
                "class": CLASS_NAMES[i],
                "confidence": f"{percentage:.2f}%"
            })
        best_result = results[0]
        image_url = upload_image(contents)
        new_record =models.History(
            image_name = image_url,
            prediction = f"{best_result['class']} - {best_result['confidence']}",
            own_id = int(current_user_id)
        )
        db.add(new_record)
        db.commit()
        db.refresh(new_record)

        return {"success": True, "predictions": results}

    except Exception as e:
        print(f"Lỗi: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/history",response_model=list[History],status_code=status.HTTP_200_OK)
@limiter.limit("10/minute")
def read_history(request: Request,db: Session = Depends(get_db),current_user_id :int= Depends(verify_token)):
    return db.query(models.History).filter(models.History.own_id == int(current_user_id)).order_by(models.History.timestamp.desc()).limit(20).all()

@app.delete("/history-delete")
def delete_history(request: Request,hs: History,db: Session = Depends(get_db),current_user_id: int= Depends(verify_token)):
    db_hs =db.query(models.History).filter(models.History.id == hs.id,models.History.own_id == int(current_user_id)).delete()
    if db_hs == 0:
        raise HTTPException(
            status_code = status.HTTP_404_NOT_FOUND,
            detail ='Không tìm thấy dữ liệu'
        )
    db.commit()
    return {"Xóa bản ghi thành công": True}

from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from pydantic import BaseModel
import secrets # Để tạo mật khẩu ngẫu nhiên cho user Google

# --- 2. CẤU HÌNH ---
# Thay dòng này bằng CLIENT ID bạn vừa lấy ở Bước 1
GOOGLE_CLIENT_ID = "624401284648-qg4bapeb16go2ja2dujftalnjb53u0ka.apps.googleusercontent.com"

# Schema cho body gửi lên
class GoogleLoginRequest(BaseModel):
    token: str

# --- 3. ENDPOINT XỬ LÝ ĐĂNG NHẬP GOOGLE ---
@app.post("/google-login", status_code=status.HTTP_200_OK)
async def google_login(request: GoogleLoginRequest, db: Session = Depends(get_db)):
    try:
        # Xác thực token với Google
        id_info = id_token.verify_oauth2_token(
            request.token, 
            google_requests.Request(), 
            GOOGLE_CLIENT_ID
        )

        email = id_info['email']
        
        # Kiểm tra xem user này đã có trong DB chưa (Dùng email làm username)
        db_user = db.query(models.User).filter(models.User.username == email).first()
       
        if not db_user:
            # Nếu chưa có -> Tự động Đăng ký
            # Tạo mật khẩu ngẫu nhiên vì họ dùng Google login, không cần pass
            random_password = secrets.token_urlsafe(16)
            hashed_password = get_password_hash(random_password)
            
            new_user = models.User(
                username=email,
                password=hashed_password
            )
            db.add(new_user)
            db.commit()
            db.refresh(new_user)
            user_id = new_user.id
        else:
            user_id = db_user.id
        # Tạo Token của app mình (JWT)
        access_token = create_access_token(data={"sub": str(user_id)})
        return {"status": "login successfully", "access_token": access_token, "token_type": "bearer"}

    except ValueError:
        raise HTTPException(status_code=400, detail="Token Google không hợp lệ")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == '__main__':
    uvicorn.run(app, host="0.0.0.0", port=8000)