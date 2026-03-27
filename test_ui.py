import re
import os 
import random
from playwright.sync_api import Page, expect

def test_animal_recognition_full_flow(page: Page):
    page.goto(f"file://{os.getcwd()}/app.html")
    
    page.locator("#login-username").fill("thune@gmail.com")
    page.locator("#login-password").fill("ntltcua3006")
    page.get_by_role("button", name="Truy cập ngay").click()
    expect(page.locator("#main-screen")).to_be_visible()
    
    token = page.evaluate("localStorage.getItem('access_token')")
    assert token is not None, "Lỗi: Không tìm thấy Access Token sau khi login!"
    expect(page.locator("#main-screen")).to_be_visible()

    page.locator("#image-upload").set_input_files("456.jpg")
    expect(page.locator("#upload-box-img")).to_be_visible()
    
    page.locator("#predict-btn").click()
    expect(page.locator("#loading")).to_be_visible()

    result_card = page.locator("#result-card")
    expect(result_card).to_be_visible(timeout=15000)

    # Kiểm tra xem có ít nhất một mục kết quả trong list không
    predictions = page.locator("#prediction-list > div.mb-2")
    expect(predictions).to_have_count(5)
    # Theo code JS của bạn: idx === 0 -> 'text-indigo-700 font-bold'
    first_item_text = predictions.nth(0).locator("span").first
    expect(first_item_text).to_have_class(re.compile(r"text-indigo-700"))
    expect(first_item_text).to_have_class(re.compile(r"font-bold"))

    # Các mục từ thứ 2 trở đi phải là màu xám (text-gray-600)
    second_item_text = predictions.nth(1).locator("span").first
    expect(second_item_text).to_have_class(re.compile(r"text-gray-600"))

    # Lấy tất cả các giá trị Confidence 
    confidences = page.locator("#prediction-list span.text-gray-500").all_text_contents()
    
    # Chuyển đổi list string sang list float để so sánh số học
    float_confidences = [float(val.strip("%")) for val in confidences]
    page.locator("#result-card").screenshot(path="screenshots/result_check.png")

    for i in range(len(float_confidences) - 1):
        assert float_confidences[i] >= float_confidences[i+1], \
            f"Lỗi sắp xếp: {float_confidences[i]} đứng trước {float_confidences[i+1]}"


    page.locator('button[onclick="loadHistory()"]').click()
    cards = page.locator("#history-list .glass-card")
    # 2. Đếm xem hiện tại có bao nhiêu card (max 20)
    count = cards.count()
    if count == 0:
        print("Danh sách trống, không có gì để xóa!")
        return

    # 3. Chọn một chỉ số (index) ngẫu nhiên từ 0 đến count-1
    random_index = random.randint(0, count - 1)

    # 4. Xác định cái card ngẫu nhiên đó
    random_card = cards.nth(random_index)

    # 5. Lấy ID của nó để tí nữa còn "đối chất"
    onclick_value = random_card.locator("button[onclick^='delH']").get_attribute("onclick")
    target_id = re.search(r'delH\((\d+),', onclick_value).group(1)

    # 6. Thực hiện hành động xóa
    random_card.locator("button[onclick^='delH']").click()
    page.get_by_role("button", name="Xóa ngay").click()
    target_selector = f"button[onclick^='delH({target_id}']"
    expect(page.locator(target_selector)).not_to_be_visible(timeout=5000)

    page.locator('button[onclick="showAppSection(\'predict\')"]').click()
    expect(page.locator("#main-screen")).to_be_visible()

    page.locator('button[onclick="logout()"]').click()
    expect(page.locator("#main-screen")).not_to_be_visible()
    expect(page.locator("#auth-screen")).to_be_visible()


    
    