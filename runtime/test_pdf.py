import fitz
import sys

doc = fitz.open(r"c:\Users\nsdha\OneDrive\code\benny\workspace\default\data_in\the_dog.pdf")
text = doc[0].get_text()
print(f"Page 1 Text Length: {len(text)}")
print(f"Page 1 Text: {text!r}")
doc.close()
