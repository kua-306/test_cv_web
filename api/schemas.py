from pydantic import BaseModel,EmailStr,field_validator
from typing import Optional
from datetime import datetime

class UserBase(BaseModel):
    username : EmailStr
    password : str
    @field_validator("username")
    @classmethod
    def validate_username(cls, value):
        if "@" not in value:
            raise ValueError("Username must be a valid email address")
        return value
    @field_validator("password")
    @classmethod
    def validate_password(cls, value):
        if len(value) < 6:
            raise ValueError("Password must be at least 6 characters long")
        return value
    
class UserLogin(BaseModel):
    username: str
    password: str
class History(BaseModel):
    id :Optional[int] = None
    image_name: Optional[str] = None
    prediction: Optional[str] = None
    timestamp: Optional[datetime] = None

class Token(BaseModel):
    status : str
    access_token: str
    token_type: str
