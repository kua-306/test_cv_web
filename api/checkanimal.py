from scipy.spatial.distance import cosine
import tensorflow as tf
from PIL import Image
import io
import numpy as np

def preprocess_image(image: Image.Image, target_size: tuple):
    if image.mode != "RGB":
        image = image.convert("RGB")
    image = image.resize(target_size)
    img_array = tf.keras.preprocessing.image.img_to_array(image)
    img_array = (img_array / 127.5) - 1.0
    img_array = np.expand_dims(img_array, axis=0)
    return img_array
# Load model nhưng bỏ lớp phân loại cuối cùng đi
# (Nếu bạn dùng Keras MobileNet có sẵn)
base_model = tf.keras.applications.MobileNetV2(
    input_shape=(224, 224, 3), 
    include_top=False, # <--- QUAN TRỌNG: Bỏ lớp cuối (Classification)
    weights='imagenet',
    pooling='avg' # Lấy trung bình để ra vector 1 chiều
)

def get_embedding(image_bytes):
    # print(f"Kiểu dữ liệu nhận được: {type(image_bytes)}")
    # 1. Xử lý ảnh giống hệt lúc predict
    image = Image.open(io.BytesIO(image_bytes))
    processed_img = preprocess_image(image, (224, 224)) # Hàm cũ của bạn
    
    # 2. Đưa qua model để lấy vector (không phải lấy tên con vật)
    # Kết quả là 1 mảng gồm 1280 số (với MobileNetV2)
    features = base_model.predict(processed_img)
    return features.flatten() # Duỗi phẳng ra thành mảng 1 chiều

def is_same_animal(vector_a, vector_b, threshold=0.2):
    # Tính khoảng cách Cosine (Góc giữa 2 vector)
    # Kết quả từ 0 (giống hệt) đến 1 (khác hẳn)
    score = cosine(vector_a, vector_b)
    
    # Nếu khoảng cách nhỏ hơn ngưỡng (ví dụ 0.2) thì là cùng 1 con
    if score < threshold:
        return True, score
    return False, score