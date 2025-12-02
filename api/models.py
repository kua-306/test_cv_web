from sqlalchemy import Column,Integer,String,DateTime,ForeignKey
from database import Base
from datetime import datetime

class User(Base):
    __tablename__ = 'users'
    id = Column(Integer,primary_key = True,index = True)
    username = Column(String)
    password = Column(String)


class History(Base):
    __tablename__ = 'history'
    id = Column(Integer,primary_key = True,index = True)
    image_name = Column(String)
    prediction = Column(String)
    timestamp = Column(DateTime,default=datetime.now) 
    own_id = Column(Integer,ForeignKey('users.id'))

