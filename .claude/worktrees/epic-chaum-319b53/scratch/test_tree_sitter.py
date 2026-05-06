import tree_sitter_python as tspython
from tree_sitter import Language, Parser

PY_LANG = Language(tspython.language())
parser = Parser(PY_LANG)

code = """
class MyClass:
    def my_method(self):
        pass

def my_func():
    pass
"""

tree = parser.parse(code.encode("utf-8"))
query = PY_LANG.query("""
    (class_definition name: (identifier) @class_name) @class
    (function_definition name: (identifier) @function_name) @function
""")

captures = query.captures(tree.root_node)
print(f"Captures type: {type(captures)}")
print(f"First 5 captures: {captures[:5]}")

try:
    print(f"Items: {captures.items()}")
except Exception as e:
    print(f"Error calling .items(): {e}")
