import fitz

doc = fitz.open(r"c:\Users\nsdha\OneDrive\code\benny\workspace\default\data_in\the_dog.pdf")
print(f"Total pages: {len(doc)}")
for i in range(min(5, len(doc))):
    text = doc[i].get_text()
    print(f"Page {i+1} Text Length: {len(text)}")
doc.close()
