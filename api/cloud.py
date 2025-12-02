import cloudinary
import cloudinary.uploader
from cloudinary.utils import cloudinary_url

# Configuration       
cloudinary.config( 
    cloud_name = "db51fa5p3", 
    api_key = "747767722781984", 
    api_secret = "MsRXRJvtxajnWRsKeP2NTrYopRQ", # Click 'View API Keys' above to copy your API secret
    secure=True
)
def upload_image(file):
        try:
            upload_result = cloudinary.uploader.upload(file)
            image_url = upload_result['secure_url']
            return image_url
        except Exception as e:
            print(f"Lỗi Cloudinary: {e}")
            return None