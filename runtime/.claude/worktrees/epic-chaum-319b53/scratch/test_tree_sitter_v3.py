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
# Correct 0.22+ way to create Query
query = Query(PY_LANG, """
    (class_definition name: (identifier) @class_name) @class
    (function_definition name: (identifier) @function_name) @function
""")

print("Query created")
cursor = QueryCursor(query)
print("Cursor created")

# In 0.22+, captures() might take the node
captures = cursor.captures(tree.root_node)
print(f"Captures type: {type(captures)}")

# In 0.22+, captures() is likely a dict or list of (node, tag)
for capture in captures:
    print(f"Capture: {capture}")
