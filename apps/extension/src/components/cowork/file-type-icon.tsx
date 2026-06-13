import {
  File,
  FileText,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileJson,
  FileAudio,
  FileVideo,
} from "lucide-react";

export function FileTypeIcon({ filename }: { filename: string }) {
  const className = "size-3.5";
  if (/\.(csv|tsv|xlsx|xlsm|xls)$/i.test(filename))
    return <FileSpreadsheet className={className} />;
  if (/\.(json|jsonl|ndjson)$/i.test(filename))
    return <FileJson className={className} />;
  if (/\.(mp3|wav|ogg|flac|m4a)$/i.test(filename))
    return <FileAudio className={className} />;
  if (/\.(mp4|mov|webm|mkv)$/i.test(filename))
    return <FileVideo className={className} />;
  if (/\.(md|txt|log)$/i.test(filename)) return <FileText className={className} />;
  if (
    /\.(ts|tsx|js|jsx|html?|css|py|rs|go|java|c|cpp|sh|yml|yaml|toml|xml|sql)$/i.test(
      filename,
    )
  )
    return <FileCode className={className} />;
  if (/\.(png|jpe?g|svg|gif|webp|avif|bmp|ico)$/i.test(filename))
    return <FileImage className={className} />;
  return <File className={className} />;
}
