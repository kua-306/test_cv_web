import os
import tensorflow as tf
from PIL import Image
import numpy as np
import time


MODEL_DIR = 'modelv2'

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

img_path=r"C:\Users\thuu\Desktop\DATN\animals_test_data"
t=0
count=0
for i in os.listdir(img_path):
        img_dir=os.path.join(img_path,i)
        image = Image.open(img_dir)
        processed_image = preprocess_image(image, (224, 224))
        input_tensor = tf.constant(processed_image, dtype=tf.float32)
        start=time.time()
        predictions_dict = serving_fn(input_tensor)
        end = time.time()
        tb_time = end - start
        if count >1:    
            t=t+tb_time
        predictions = list(predictions_dict.values())[0]
        probs = predictions.numpy()[0]
        top_indices = np.argsort(probs)[::-1]
        count+=1
        
print(t/(count-2))