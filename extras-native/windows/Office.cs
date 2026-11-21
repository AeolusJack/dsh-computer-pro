using System.Globalization;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using W=DocumentFormat.OpenXml.Wordprocessing;
using S=DocumentFormat.OpenXml.Spreadsheet;

// Saved-file adapters. Never attaches to a user's ActiveDocument or saves over the source.
internal static class Office {
    static string PathArg(JsonElement r,string key) {
        var path=r.GetProperty(key).GetString()??"";
        if(!Path.IsPathFullyQualified(path)||path.Contains('\0'))throw new ArgumentException("ABSOLUTE_FILE_PATH_REQUIRED");
        return Path.GetFullPath(path);
    }
    static string Format(string path) => Path.GetExtension(path).ToLowerInvariant() switch {
        ".docx"=>"docx",".xlsx"=>"xlsx",".rtf"=>"rtf",".txt"=>"txt",
        _=>throw new ArgumentException("UNSUPPORTED_OFFICE_FORMAT: use docx, xlsx, rtf or UTF-8 txt")};
    static void CheckFile(string path) {
        var f=new FileInfo(path);if(!f.Exists||f.Length>64*1024*1024)throw new ArgumentException("DOCUMENT_MISSING_OR_TOO_LARGE");
        if((f.Attributes&FileAttributes.ReparsePoint)!=0)throw new ArgumentException("DOCUMENT_REPARSE_POINT");
        if(Format(path) is "docx" or "xlsx") {using var zip=ZipFile.OpenRead(path);
            if(zip.Entries.Count>10000||zip.Entries.Sum(e=>e.Length)>128*1024*1024)throw new ArgumentException("DOCUMENT_EXPANSION_LIMIT");}
    }
    static OpenSettings Settings() => new(){AutoSave=true,MaxCharactersInPart=10000000};
    static string ParagraphText(W.Paragraph p) => string.Concat(p.Descendants().Select(n=>n switch {W.Text t=>t.Text,W.TabChar=>"\t",W.Break=>"\n",_=>""}));
    static string RichText(string path) {using var box=new System.Windows.Forms.RichTextBox();box.LoadFile(path);return box.Text;}
    static string Utf8Text(string path) => new UTF8Encoding(false,true).GetString(File.ReadAllBytes(path)).TrimStart('\uFEFF');
    static object TextSnapshot(string path,string format) {
        if(format=="docx") {
            using var buffer=new MemoryStream(); buffer.Write(File.ReadAllBytes(path)); buffer.Position=0; using var doc=WordprocessingDocument.Open(buffer,true,new OpenSettings{AutoSave=false,MaxCharactersInPart=10000000});
            var body=doc.MainDocumentPart?.Document?.Body??throw new ArgumentException("DOCUMENT_BODY_MISSING");
            var paragraphs=body.Descendants<W.Paragraph>().Select((p,i)=>new{index=i+1,text=ParagraphText(p)}).ToArray();
            var text=string.Join("\n",paragraphs.Select(p=>p.text));if(text.Length>500000)throw new ArgumentException("DOCUMENT_TEXT_LIMIT");
            return new{text,paragraphs=paragraphs.Take(2000),totalParagraphs=paragraphs.Length,truncatedParagraphs=paragraphs.Length>2000,
                scope="main document body including table paragraphs; excludes headers/footers/comments and unsaved edits"};
        }
        string plain=format=="rtf"?RichText(path):Utf8Text(path);if(plain.Length>500000)throw new ArgumentException("DOCUMENT_TEXT_LIMIT");
        return new{text=plain,paragraphs=plain.Split('\n').Take(2000).Select((t,i)=>new{index=i+1,text=t}),scope="saved file"};
    }
    static (int X,int Y) CellPosition(string address) {
        var match=Regex.Match(address,@"^([A-Z]{1,3})([1-9][0-9]{0,6})$");if(!match.Success)throw new ArgumentException("INVALID_CELL_ADDRESS");
        int x=0;foreach(char c in match.Groups[1].Value)x=x*26+c-'A'+1;
        int y=int.Parse(match.Groups[2].Value);if(x>16384||y>1048576)throw new ArgumentException("CELL_OUT_OF_BOUNDS");return(x,y);
    }
    static (int X1,int Y1,int X2,int Y2) Bounds(string address) {
        var parts=address.Split(':');if(parts.Length>2)throw new ArgumentException("INVALID_RANGE");
        var first=CellPosition(parts[0]);var last=CellPosition(parts[^1]);
        if(last.X<first.X||last.Y<first.Y)throw new ArgumentException("INVALID_RANGE_ORDER");return(first.X,first.Y,last.X,last.Y);
    }
    static string Address(int x,int y) {string c="";while(x>0){x--;c=(char)('A'+x%26)+c;x/=26;}return c+y;}
    static WorksheetPart Sheet(SpreadsheetDocument doc,JsonElement r,out string name) {
        var workbook=doc.WorkbookPart??throw new ArgumentException("WORKBOOK_MISSING");var sheets=workbook.Workbook!.Sheets?.Elements<S.Sheet>().ToArray()??[];
        var sheet=r.TryGetProperty("sheet",out var s)?sheets.SingleOrDefault(x=>x.Name?.Value==s.GetString()):sheets.FirstOrDefault();
        if(sheet?.Id?.Value==null)throw new ArgumentException("SHEET_NOT_FOUND");name=sheet.Name?.Value??"";return(WorksheetPart)workbook.GetPartById(sheet.Id.Value);
    }
    static object? Value(SpreadsheetDocument doc,S.Cell? cell) {
        if(cell==null)return null;var raw=cell.CellValue?.Text;
        if(cell.DataType?.Value==S.CellValues.InlineString)return cell.InlineString?.InnerText??"";
        if(cell.DataType?.Value==S.CellValues.SharedString) {
            if(!int.TryParse(raw,out var index)||index<0)throw new ArgumentException("INVALID_SHARED_STRING");
            return doc.WorkbookPart?.SharedStringTablePart?.SharedStringTable!.Elements<S.SharedStringItem>().ElementAtOrDefault(index)?.InnerText??throw new ArgumentException("SHARED_STRING_MISSING");}
        if(cell.DataType?.Value==S.CellValues.Boolean)return raw=="1";
        if(cell.DataType==null||cell.DataType.Value==S.CellValues.Number)return double.TryParse(raw,NumberStyles.Float,CultureInfo.InvariantCulture,out var number)?number:null;
        return raw;
    }
    static object SheetSnapshot(string path,JsonElement r) {
        using var buffer=new MemoryStream(); buffer.Write(File.ReadAllBytes(path)); buffer.Position=0; using var doc=SpreadsheetDocument.Open(buffer,true,new OpenSettings{AutoSave=false,MaxCharactersInPart=10000000});var sheet=Sheet(doc,r,out var name);
        string address=r.TryGetProperty("range",out var range)?range.GetString()??"":"A1:T50";var b=Bounds(address);int width=b.X2-b.X1+1,height=b.Y2-b.Y1+1;
        if(width>100||height>500||width*height>10000)throw new ArgumentException("RANGE_LIMIT: at most 10000 cells, 500 rows, 100 columns");
        var cells=sheet.Worksheet!.Descendants<S.Cell>().Where(c=>c.CellReference!=null).ToDictionary(c=>c.CellReference!.Value!);
        var values=new object?[height][];var formulas=new string?[height][];
        for(int y=0;y<height;y++){values[y]=new object?[width];formulas[y]=new string?[width];for(int x=0;x<width;x++){
            cells.TryGetValue(Address(b.X1+x,b.Y1+y),out var cell);values[y][x]=Value(doc,cell);formulas[y][x]=cell?.CellFormula?.Text;}}
        return new{sheet=name,range=address,rows=height,columns=width,values,formulas,
            sheets=doc.WorkbookPart!.Workbook!.Sheets!.Elements<S.Sheet>().Select(s=>s.Name?.Value),
            formulaValues="cached saved results; formulas are not calculated here",dates="numeric serial values; original cell styles retained"};
    }
    static object Snapshot(string path,string format,JsonElement r) => format=="xlsx"?SheetSnapshot(path,r):TextSnapshot(path,format);
    static void CopyStable(string source,string target) {using var input=new FileStream(source,FileMode.Open,FileAccess.Read,FileShare.Read);using var output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None);input.CopyTo(output);}
    internal static object Read(JsonElement r) {
        string path=PathArg(r,"path");var format=Format(path);CheckFile(path);
        using var lease=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
        return new{path,engine=format=="rtf"?"Windows RichEdit":"OpenXML / UTF-8",source="saved-file-api",data=Snapshot(path,format,r)};
    }
    static int Unique(string text,string find) {
        if(string.IsNullOrEmpty(find))throw new ArgumentException("EMPTY_SEARCH");int index=text.IndexOf(find,StringComparison.Ordinal);
        if(index<0||text.IndexOf(find,index+1,StringComparison.Ordinal)>=0)throw new ArgumentException("TEXT_NOT_UNIQUE: exactly one occurrence is required");return index;
    }
    static void ReplaceText(string path,string format,JsonElement op) {
        string find=op.GetProperty("find").GetString()??"",replacement=op.GetProperty("replacement").GetString()??"";
        if(replacement.Length>100000)throw new ArgumentException("REPLACEMENT_TOO_LARGE");
        if(format=="docx") {
            using var doc=WordprocessingDocument.Open(path,true,Settings());var body=doc.MainDocumentPart!.Document!.Body!;
            if(body.Descendants<W.DeletedRun>().Any()||body.Descendants<W.InsertedRun>().Any())throw new ArgumentException("TRACKED_CHANGES_UNSUPPORTED");
            var paragraphs=body.Descendants<W.Paragraph>().ToArray();Unique(string.Join("\n",paragraphs.Select(ParagraphText)),find);
            var paragraph=paragraphs.SingleOrDefault(p=>ParagraphText(p).Contains(find,StringComparison.Ordinal))??throw new ArgumentException("CROSS_PARAGRAPH_REPLACEMENT_UNSUPPORTED");
            if(paragraph.Descendants<W.FieldChar>().Any()||paragraph.Descendants<W.SimpleField>().Any()||paragraph.Descendants<W.Paragraph>().Any()||paragraph.Descendants<W.TabChar>().Any()||paragraph.Descendants<W.Break>().Any())throw new ArgumentException("COMPLEX_PARAGRAPH_REPLACEMENT_UNSUPPORTED");
            if(replacement.Contains('\n')||replacement.Contains('\r'))throw new ArgumentException("DOCX_REPLACEMENT_MUST_BE_SINGLE_PARAGRAPH");
            var nodes=paragraph.Descendants<W.Text>().ToArray();int index=Unique(string.Concat(nodes.Select(n=>n.Text)),find),end=index+find.Length,offset=0;bool inserted=false;
            foreach(var node in nodes){var old=node.Text;int from=Math.Max(0,index-offset),to=Math.Min(old.Length,end-offset);
                if(from<to){node.Text=old[..from]+(inserted?"":replacement)+old[to..];node.Space=SpaceProcessingModeValues.Preserve;inserted=true;}offset+=old.Length;}
        }else if(format=="rtf") {
            using var box=new System.Windows.Forms.RichTextBox();box.LoadFile(path);int index=Unique(box.Text,find);box.Select(index,find.Length);box.SelectedText=replacement;box.SaveFile(path);
        }else{string text=Utf8Text(path);int index=Unique(text,find);File.WriteAllText(path,text[..index]+replacement+text[(index+find.Length)..],new UTF8Encoding(false));}
    }
    static void SetCell(string path,JsonElement op) {
        using var doc=SpreadsheetDocument.Open(path,true,Settings());var part=Sheet(doc,op,out _);
        if(part.Worksheet!.Elements<S.SheetProtection>().Any())throw new ArgumentException("PROTECTED_SHEET");
        var address=op.GetProperty("cell").GetString()??"";var p=CellPosition(address);
        foreach(var merged in part.Worksheet!.Descendants<S.MergeCell>()){var b=Bounds(merged.Reference!.Value!);if(p.X>=b.X1&&p.X<=b.X2&&p.Y>=b.Y1&&p.Y<=b.Y2)throw new ArgumentException("MERGED_CELL_EDIT_UNSUPPORTED");}
        var data=part.Worksheet!.GetFirstChild<S.SheetData>()??throw new ArgumentException("SHEET_DATA_MISSING");var row=data.Elements<S.Row>().SingleOrDefault(r=>r.RowIndex?.Value==p.Y);var cell=row?.Elements<S.Cell>().SingleOrDefault(c=>c.CellReference?.Value==address);
        if(!op.TryGetProperty("expected",out var expected)||!JsonElement.DeepEquals(JsonSerializer.SerializeToElement(Value(doc,cell)),expected))throw new ArgumentException("CELL_PRECONDITION_FAILED");
        if(cell?.CellFormula?.FormulaType?.Value==S.CellFormulaValues.Array||cell?.CellFormula?.FormulaType?.Value==S.CellFormulaValues.Shared)throw new ArgumentException("ARRAY_OR_SHARED_FORMULA_EDIT_UNSUPPORTED");
        if(row==null){row=new S.Row{RowIndex=(uint)p.Y};data.InsertBefore(row,data.Elements<S.Row>().FirstOrDefault(r=>r.RowIndex!.Value>p.Y));}
        if(cell==null){cell=new S.Cell{CellReference=address};row.InsertBefore(cell,row.Elements<S.Cell>().FirstOrDefault(c=>CellPosition(c.CellReference!.Value!).X>p.X));}
        cell.CellFormula=null;cell.CellValue=null;cell.InlineString=null;
        if(op.TryGetProperty("formula",out var formula)) {
            var value=formula.GetString()??"";if(!value.StartsWith('=')||value.Length>8192)throw new ArgumentException("INVALID_FORMULA");cell.DataType=null;cell.CellFormula=new S.CellFormula(value[1..]);
        }else {
            var value=op.GetProperty("value");
            if(value.ValueKind==JsonValueKind.String){cell.DataType=S.CellValues.InlineString;cell.InlineString=new S.InlineString(new S.Text(value.GetString()??""){Space=SpaceProcessingModeValues.Preserve});}
            else if(value.ValueKind==JsonValueKind.Number){cell.DataType=S.CellValues.Number;cell.CellValue=new S.CellValue(value.GetRawText());}
            else if(value.ValueKind is JsonValueKind.True or JsonValueKind.False){cell.DataType=S.CellValues.Boolean;cell.CellValue=new S.CellValue(value.GetBoolean()?"1":"0");}
            else if(value.ValueKind==JsonValueKind.Null)cell.DataType=null;else throw new ArgumentException("INVALID_CELL_VALUE");
        }
        foreach(var sheet in doc.WorkbookPart!.WorksheetParts)foreach(var formulaCell in sheet.Worksheet!.Descendants<S.Cell>().Where(c=>c.CellFormula!=null))formulaCell.CellValue=null;
        if(doc.WorkbookPart.CalculationChainPart is {} chain)doc.WorkbookPart.DeletePart(chain);
        doc.WorkbookPart.Workbook!.CalculationProperties=new S.CalculationProperties{FullCalculationOnLoad=true,ForceFullCalculation=true};
    }
    internal static object EditCopy(JsonElement r) {
        string source=PathArg(r,"path"),output=PathArg(r,"outputPath");var format=Format(source);CheckFile(source);
        if(Format(output)!=format)throw new ArgumentException("COPY_EXTENSION_MUST_MATCH");if(File.Exists(output))throw new ArgumentException("OUTPUT_ALREADY_EXISTS");
        var operations=r.GetProperty("operations");if(operations.ValueKind!=JsonValueKind.Array||operations.GetArrayLength()<1||operations.GetArrayLength()>100)throw new ArgumentException("OPERATIONS_LIMIT: 1 to 100");
        string stage=Path.Combine(Path.GetDirectoryName(output)!,".computer-pro-"+Guid.NewGuid().ToString("N")+Path.GetExtension(source));
        try{
            CopyStable(source,stage);CheckFile(stage);string sourceHash=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(stage))).ToLowerInvariant();
            foreach(var op in operations.EnumerateArray()) {
                string kind=op.GetProperty("kind").GetString()??"";
                if(format=="xlsx"&&kind=="setCell")SetCell(stage,op);else if(format!="xlsx"&&kind=="replaceText")ReplaceText(stage,format,op);else throw new ArgumentException("UNSUPPORTED_OFFICE_OPERATION");
            }
            var data=Snapshot(stage,format,r);File.Move(stage,output,false);
            return new{dispatched=true,saved=true,reopened=true,verified=false,source,sourceSha256=sourceHash,outputPath=output,data,
                next="Compare reopened data with intended edits; formulas require recalculation in WPS/Excel. Unsaved UI contents were not changed.",
                warning=format=="rtf"?"RichEdit may normalize RTF formatting; review complex documents visually.":null};
        }finally{if(File.Exists(stage))File.Delete(stage);}
    }
}
