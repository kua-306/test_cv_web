from sqlalchemy import create_async_engine,AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy.ext.declarative import declarative_base

URL_DATABASE = "sqlite+aiosqlite:///./sql_app.db"

engine = create_async_engine(URL_DATABASE,connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit = False,autoflush = False,class_=AsyncSession, bind = engine)
Base = declarative_base()
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()