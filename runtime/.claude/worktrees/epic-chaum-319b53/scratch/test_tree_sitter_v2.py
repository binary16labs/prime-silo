import tree_sitter_python as tspython
from tree_sitter import Language, Parser, Query, QueryCursor

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

cursor = QueryCursor()
captures = cursor.captures(query, tree.root_node)
print(f"Captures: {captures}")
for node, tag in captures:
    print(f"Node: {node}, Tag: {tag}")
