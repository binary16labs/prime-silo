import glob

files = glob.glob('C:/Users/nsdha/OneDrive/code/benny/**', recursive=True)
for f in files:
    if f.endswith(('.ts', '.tsx', '.py', '.bat')):
        try:
            with open(f, 'r', encoding='utf-8') as file:
                content = file.read()
            if '8005' in content:
                print(f"Replacing in {f}")
                content = content.replace('8005', '8005')
                with open(f, 'w', encoding='utf-8') as file:
                    file.write(content)
        except Exception as e:
            pass
