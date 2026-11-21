"""Minimal standards-based fixtures; only Python's standard library is needed."""
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
def package(name, main, content_type, files):
    files['[Content_Types].xml']=f'''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/{main}" ContentType="{content_type}"/>'''+('''<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>''' if name.endswith('xlsx') else '')+'</Types>'
    files['_rels/.rels']=f'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{main}"/></Relationships>'''
    with ZipFile(out/name,'w',ZIP_DEFLATED) as z:
        for path,text in files.items():z.writestr(path,text)
package('source.docx','word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',{
'word/document.xml':'''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Computer Pro: replace </w:t></w:r><w:r><w:t>me here</w:t></w:r></w:p><w:p><w:r><w:t>Duplicate Duplicate</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell 中文</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>'''})
package('source.xlsx','xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',{
'xl/workbook.xml':'''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>''',
'xl/_rels/workbook.xml.rels':'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>''',
'xl/worksheets/sheet1.xml':'''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c><c r="B1"><v>12</v></c><c r="C1"><f>B1*2</f><v>24</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>原始内容</t></is></c></row></sheetData></worksheet>'''})
(out/'source.rtf').write_text(r'{\rtf1\ansi Computer Pro structured test\par Line one: replace me\par Final line.}',encoding='ascii')
(out/'source.txt').write_text('Unicode 中文\nreplace me\n',encoding='utf-8')
