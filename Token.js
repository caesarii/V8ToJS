/**
 * 普通node模式不支持import语法
 * 需安装babel-node工具
 */
import Scanner from './Parsing/scanner/Scanner';
import Stream from './Parsing/scanner/Stream';

// 在这里设置待编译字符串
const source_code = `
let a = 1;
`;

let stream = new Stream(source_code);
let scanner = new Scanner(stream);
let currentToken = '';
// 启动扫描器
scanner.Initialize();
/**
 * 扫描下一个Token并打印出来
 * 注意 不要放入带有插值(即${})的模板字符串 该Token解析较为特殊
 */
while(true) {
  currentToken = scanner.Next();
  console.log(currentToken);
  if(currentToken === 'Token::EOS') break;
}