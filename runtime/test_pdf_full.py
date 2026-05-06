import fitz
doc = fitz.open(r"c:\Users\nsdha\OneDrive\code\benny\workspace\default\data_in\the_dog.pdf")
text = ""
for page in doc:
    text += page.get_text()
print(f"Total extracted text length: {len(text)}")
import json
print(json.dumps(text[:100]))
doc.close()
