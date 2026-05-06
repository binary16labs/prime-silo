import fitz

doc = fitz.open(r"c:\Users\nsdha\OneDrive\code\benny\workspace\default\data_in\the_dog.pdf")
blocks = doc[0].get_text("blocks")
print(f"Page 1 Block Count: {len(blocks)}")
print(f"Page 1 Blocks: {blocks[:2]}")
doc.close()
