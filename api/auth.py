from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi import Depends, FastAPI, HTTPException, status
from sqlalchemy.orm import Session
from passlib.context import CryptContext
from database import engine,get_db
from jose import jwt,JWTError
from datetime import datetime, timedelta
import models as models


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
def get_password_hash(password):
    return pwd_context.hash(password)
def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")
SECRET_KEY = "matmabimatsieukhodoancuathuu"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30
def create_access_token(data: dict):
    to_encode = data.copy()
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def verify_token(token: str):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        own_id: str = payload.get("sub")
        return own_id
    except JWTError as e:
        return {"error": str(e)}


# async def get_current_user(token: str = Depends(oauth2_scheme),db: Session = Depends(get_db)):
#     credentials_exception = HTTPException(
#         status_code=status.HTTP_401_UNAUTHORIZED,
#         detail="Could not validate credentials",
#         headers={"WWW-Authenticate": "Bearer"},
#     )
#     own_id = verify_token(token, credentials_exception)
#     user = db.query(models.User).filter(models.User.id == own_id).first()
#     if user is None:
#         raise credentials_exception
#     return user




