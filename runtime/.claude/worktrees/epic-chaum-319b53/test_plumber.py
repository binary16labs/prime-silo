import pdfplumber
with pdfplumber.open(r"c:\Users\nsdha\OneDrive\code\benny\workspace\default\data_in\the_dog.pdf") as pdf:
    text = ""
    for i in range(min(5, len(pdf.pages))):
        extracted = pdf.pages[i].extract_text()
        if extracted: text += extracted
    print(f"pdfplumber extracted: {len(text)} chars from first 5 pages")
