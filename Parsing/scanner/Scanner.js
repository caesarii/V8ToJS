import Stream from './Stream';
import PerfectKeywordHash from './PerfectKeywordHash';
import TokenDesc from './TokenDesc';
import Location from './Location';

import { 
  kMaxAscii, 
  kIdentifierNeedsSlowPath,
  kEndOfInput,
  ALLOW_HEX,
  ALLOW_OCTAL,
  ALLOW_IMPLICIT_OCTAL,
  ALLOW_BINARY,
} from '../../enum';

import {
  TerminatesLiteral,
  IdentifierNeedsSlowPath,
  CanBeKeyword,
  character_scan_flags, 
  UnicodeToToken, 
  UnicodeToAsciiMapping,
  AsciiAlphaToLower,
  IsIdentifierStart,

  IsBinaryDigit,
  IsOctalDigit,
  IsDecimalDigit,
  IsHexDigit,
  IsNonOctalDecimalDigit,
  IsDecimalNumberKind,
  IsValidBigIntKind,
  IsWhiteSpaceOrLineTerminator,
  StringToDouble,
  IsLineTerminator,
} from '../../util';

import {
  kStrictDecimalWithLeadingZero,
  kZeroDigitNumericSeparator,
  kContinuousNumericSeparator,
  kTrailingNumericSeparator,
} from '../../MessageTemplate';

const IMPLICIT_OCTAL = 0;
const BINARY = 1;
const OCTAL = 2;
const HEX = 3;
const DECIMAL = 4;
const DECIMAL_WITH_LEADING_ZERO = 5;

/**
 * v8新特性
 * 详情见https://v8.dev/blog/v8-release-75
 */
const allow_harmony_numeric_separator = () => true;

const Smi_kMaxValue = 2**31 - 1;

const kCharacterLookaheadBufferSize = 1;

export default class Scanner {
  constructor(source, is_module) {
    this.source_ = source;
    this.found_html_comment_ = false;
    this.allow_harmony_optional_chaining_ = false;
    this.allow_harmony_nullish_ = false;
    this.is_module_ = is_module;
    /**
     * 当前字符的Unicode编码
     * 如果为null代表解析完成
     */
    this.c0_ = null;
    /**
     * 新增变量
     * 由于JS中字符与对应的Unicode值不对等
     * 所以c0_表示Unicode 对应的字符变量为char
     * 所有变动c0_的方法会同步更新char的值
     */
    this.char = '';
    /**
     * scanner有三个词法描述类 分别代表当前、下一个、下下一个三个Token
     * token_storage_是一个数组 里面装着那个三个类
     */
    this.current_ = new TokenDesc();
    this.next_ = new TokenDesc();
    this.next_next_ = new TokenDesc();
    this.token_storage_ = [this.current_, this.next_, this.next_next_];

    this.octal_pos_ = new Location().invalid();
    this.octal_message_ = '';
  }
  source_pos() {
    return this.source_.pos() - kCharacterLookaheadBufferSize;
  }
  HasLineTerminatorBeforeNext() {
    return this.next_.after_line_terminator;
  }
  HasLineTerminatorAfterNext() {
    return this.next_next_.after_line_terminator;
  }
  // TODO
  literal_contains_escapes() {
    return false;
  }
  /**
   * 源码中这三个方法返回的是指针
   */
  current() { return this.current_; }
  next() { return this.next_; }
  next_next() { return this.next_next_; }
  /**
   * 返回下一个token
   */
  Next() {
    /**
     * 交换token 理论上不调用PeekAhead，next_next_会一直保持Token::UNINITIALIZED
     * 首先生成临时变量previous 赋值current_
     * (cur_, next_) => (next_, ???)
     * 1、当next_next_为Token::UNINITIALIZED时
     * (cur_, next_, Token::UNINITIALIZED) => (next_, 新Scan的Token, Token::UNINITIALIZED)
     * 2、next_next_若有值 不会进行Scan 仅进行移位
     * (cur_, next_, next_next_) => (next_, next_next_, Token::UNINITIALIZED)
     * @returns {Token} 返回解析前的next_.token
     */
    let previous = this.current_;
    this.current_ = this.next_;
    if (this.next_next().token === 'Token::UNINITIALIZED') {
      this.next_ = previous;
      previous.after_line_terminator = false;
      this.Scan(previous);
    } else {
      this.next_ = this.next_next_;
      this.next_next_ = previous;
      previous.token = 'Token::UNINITIALIZED';
    }
    return this.current().token;
  }
  AddLiteralChar(c) {
    this.next().literal_chars.AddChar(c);
  }
  AddRawLiteralChar(c) {
    this.next().raw_literal_chars.AddChar(c);
  }
  CurrentLiteralEquals(target) {
    if (!this.is_literal_one_byte()) return false;
    let current = this.literal_one_byte_string();
    return current === target;
  }
  AdvanceUntil(callback) {
    this.c0_ = this.source_.AdvanceUntil(callback);
    this.char = String.fromCharCode(this.c0_);
  }
  PushBack(ch) {
    this.source_.Back();
    this.c0_ = ch;
    this.char = String.fromCharCode(this.c0_);
  }
  current_token() { return this.current_.token; }
  peek() { return this.next().token; }
  peek_location() { return this.next().location; }
  location() { return this.current().location; }
  Peek() { return String.fromCharCode(this.source_.Peek()); }
  /**
   * 返回next_next_的值或next_保持不变 将下一个token解析到next_next_上 
   */
  PeekAhead() {
    if (this.next_next().token !== 'Token::UNINITIALIZED') return this.next_next().token;
    let temp = this.next_;
    this.next_ = this.next_next_;
    // 这个地方的顺序修改过 存疑
    this.Scan();
    this.next_.after_line_terminator = false;
    this.next_next_ = this.next_;
    this.next_ = temp;
    return this.next_next_.token;
  }
  smi_value() { return this.current().smi_value_; }
  /**
   * 初始化scanner 同时解析第一个Token
   */
  Initialize() {
    this.Init();
    this.next().after_line_terminator = true;
    this.Scan();
  }
  Init() {
    this.Advance();
    // 源码在这里初始化 对于JS来说没必要
    // this.token_storage_[0] = this.current_;
    // this.token_storage_[1] = this.next_;
    // this.token_storage_[2] = this.next_next_;
  }
  Advance() {
    this.c0_ = this.source_.Advance();
    this.char = String.fromCharCode(this.c0_);
  }
  AddLiteralCharAdvance() {
    this.AddLiteralChar(this.c0_);
    this.Advance();
  }
  /**
   * 这里有函数重载 JS就直接用默认参数模拟了
   */
  Scan(next = this.next_) {
    next.token = this.ScanSingleToken();
    next.location.end_pos = this.source_pos();
  }
  /**
   * 单个词法的解析
   */
  ScanSingleToken() {
    let token = null;
    do {
      this.next().location.beg_pos = this.source_pos();
      if (this.c0_ < kMaxAscii && this.c0_ > 0) {
        token = UnicodeToToken[this.c0_];
        switch(token) {
          case 'Token::LPAREN':
          case 'Token::RPAREN':
          case 'Token::LBRACE':
          case 'Token::RBRACE':
          case 'Token::LBRACK':
          case 'Token::RBRACK':
          case 'Token::CONDITIONAL':
          case 'Token::COLON':
          case 'Token::SEMICOLON':
          case 'Token::COMMA':
          case 'Token::BIT_NOT':
          case 'Token::ILLEGAL':
            return this.Select(token);

          case 'Token::STRING':
            return this.ScanString();

          case 'Token::LT':
            // < <= << <<= <!--
            this.Advance();
            if (this.char === '=') return this.Select('Token::LTE');
            if (this.char === '<') return this.Select('=', 'Token::ASSIGN_SHL', 'Token::SHL');
            if (this.char === '!') {
              token = this.ScanHtmlComment();
              continue;
            }
            return 'Token::LT';
          
          case 'Token::GT':
            // > >= >> >>= >>> >>>=
            this.Advance();
            if (this.char === '=') return this.Select('Token::GTE');
            if (this.char === '>') {
              // >> >>= >>> >>>=
              this.Advance();
              if (this.char === '=') return this.Select('Token::ASSIGN_SAR');
              if (this.char === '>') return this.Select('=', 'Token::ASSIGN_SHR', 'Token::SHR');
              return 'Token::SAR';
            }
            return 'Token::GT';

          case 'Token::ASSIGN':
            this.Advance();
            if (this.char === '=') return this.Select('=','Token::EQ_STRICT', 'Token::EQ');
            if (this.char === '>') return this.Select('Token::ARROW');
            return 'Token::ASSIGN';
          
          case 'Token::NOT':
            // ! != !==
            this.Advance();
            if (this.char === '=') return this.Select('=', 'Token::NE_STRICT', 'Token::NE');
            return 'Token::NOT';

          case 'Token::ADD':
            // + ++ +=
            this.Advance();
            if (this.char === '+') return this.Select('Token::INC');
            if (this.char === '=') return this.Select('Token::ASSIGN_ADD');
            return 'Token::ADD';
          
          case 'Token::SUB':
            // - -- --> -=
            this.Advance();
            if (this.char === '-') {
              this.Advance();
              if (this.char === '>' && this.next().after_line_terminator) {
                // For compatibility with SpiderMonkey, we skip lines that
                // start with an HTML comment end '-->'.
                token = this.SkipSingleHTMLComment();
                continue;
              }
              return 'Token::DEC';
            }
            if (this.char === '=') return this.Select('Token::ASSIGN_SUB');
            return 'Token::SUB';
          
          case 'Token::MUL':
            // * *=
            this.Advance();
            if (this.char === '*') return this.Select('=', 'Token::ASSIGN_EXP', 'Token::EXP');
            if (this.char === '=') return this.Select('Token::ASSIGN_MUL');
            return 'Token::MUL';

          case 'Token::MOD':
            // % %=
            return this.Select('=', 'Token::ASSIGN_MOD', 'Token::MOD');

          case 'Token::DIV':
            // /  // /* /=
            this.Advance();
            if (this.char === '/') {
              let c = this.Peek();
              if (c === '#' || c === '@') {
                this.Advance();
                this.Advance();
                token = this.SkipSourceURLComment();
                continue;
              }
              token = this.SkipSingleLineComment();
              continue;
            }
            if (this.char === '*') {
              token = this.SkipMultiLineComment();
              continue;
            }
            if (this.char === '=') return this.Select('Token::ASSIGN_DIV');
            return 'Token::DIV';
          
          case 'Token::BIT_AND':
            // & && &=
            this.Advance();
            if (this.char === '&') return this.Select('Token::AND');
            if (this.char === '=') return this.Select('Token::ASSIGN_BIT_AND');
            return 'Token::BIT_AND';
          
          case 'Token::BIT_OR':
            // | || |=
            this.Advance();
            if (this.char === '|') return this.Select('Token::OR');
            if (this.char === '=') return this.Select('Token::ASSIGN_BIT_OR');
            return 'Token::BIT_OR';

          case 'Token::BIT_XOR':
            // ^ ^=
            return this.Select('=', 'Token::ASSIGN_BIT_XOR', 'Token::BIT_XOR');

          case 'Token::PERIOD':
            // . Number
            this.Advance();
            if (IsDecimalDigit(this.c0_)) return this.ScanNumber(true);
            if (this.char === '.') {
              if (this.Peek() === '.') {
                this.Advance();
                this.Advance();
                return 'Token::ELLIPSIS';
              }
            }
            return 'Token::PERIOD';
          
          case 'Token::TEMPLATE_SPAN':
            this.Advance();
            return this.ScanTemplateSpan();

          case 'Token::PRIVATE_NAME':
            return this.ScanPrivateName();

          case 'Token::WHITESPACE':
            token = this.SkipWhiteSpace();
            continue;

          case 'Token::NUMBER':
            return this.ScanNumber(false);

          case 'Token::IDENTIFIER':
            return this.ScanIdentifierOrKeyword();

          default:
            this.UNREACHABLE();
        } 
      }
      if (this.c0_ === kEndOfInput) return 'Token::EOS';

      token = this.SkipWhiteSpace();
    } while(token === 'Token::WHITESPACE')
    return token;
  }
  ReportScannerError(pos, msg) { throw new Error(`fatal error found at ${this.source_.source_string[pos]}`) };
  UNREACHABLE() { throw new Error('unreachable code'); }
  Select(...args) {
    this.Advance();
    if (args.length === 1) return args[0];
    else if (UnicodeToAsciiMapping[this.c0_] === args[0]) {
      this.Advance();
      return args[1];
    }
    return args[2];
  }

  /**
   * 处理空格
   */
  SkipWhiteSpace() {
    let start_position = this.source_pos();
    while(IsWhiteSpaceOrLineTerminator(this.c0_)) {
      if (!this.next().after_line_terminator) {
        this.next().after_line_terminator = true;
      }
      this.Advance();
    }
    if (this.source_pos() === start_position) return 'Token::ILLEGAL';

    return 'Token::WHITESPACE';
  }
  /**
   * 处理html注释 <!--
   */
  ScanHtmlComment() {
    this.Advance();
    // 如果不是<!-- 则撤回到<!的状态
    if(String.fromCharCode(this.c0_) !== '-' || this.Peek() !== '-') {
      this.PushBack('!');
      return 'Token::LT';
    }
    this.Advance();
    this.found_html_comment_ = true;
    return this.SkipSingleHTMLComment();
  }
  SkipSingleHTMLComment() {
    if(this.is_module_) throw new Error('Token::ILLEGAL');
    return this.SkipSingleLineComment();
  }
  SkipSingleLineComment() {
    this.AdvanceUntil((c0_) => IsLineTerminator(c0_));
    return 'Token::WHITESPACE';
  }
  SkipMultiLineComment() {
    if(!this.next().after_line_terminator) {
      do {
        this.AdvanceUntil((c0) => {
          if(c0 > kMaxAscii) return IsLineTerminator(c0);
          let char_flags = character_scan_flags[c0];
          return this.MultilineCommentCharacterNeedsSlowPath(char_flags);
        });
        while(this.c0_ === '*') {
          this.Advance();
          if(this.c0_ === '/') {
            this.Advance();
            return 'Token::WHITESPACE';
          }
        }

        if(IsLineTerminator(this.c0_)) {
          this.next().after_line_terminator = true;
          break;
        }
      } while(this.c0_ !== 'kEndOfInput');
    }

    while(this.c0_ !== 'kEndOfInput') {
      this.AdvanceUntil((c0) => c0 === '*');
      while(this.c0_ === '*') {
        this.Advance();
        if(this.c0_ === '/') {
          this.Advance();
          return 'Token::WHITESPACE';
        }
      }
    }

    return 'Token::ILLEGAL';
  }
  
  /**
   * 解析数字相关
   * literal作为字面量类无所不能!
   */
  ScanNumber(seen_period) {
    let kind = DECIMAL;
    this.next().literal_chars.Start();
    // 正常写法的数字
    let as_start = !seen_period;
    let start_pos = this.source_pos();
    // 处理简写
    if (seen_period) {
      this.AddLiteralChar('.');
      if (allow_harmony_numeric_separator() && this.c0_ === '_') return 'TOKEN:ILLEGAL';
      if (!this.ScanDecimalDigits()) return 'TOKEN:ILLEGAL';
    } else {
      /**
       * 共有数字0、0exxx、0Exxx、0.xxx、二进制、十六进制、八进制、0开头的十进制、隐式八进制九种情况
       */
      if (UnicodeToAsciiMapping[this.c0_] === '0') {
        this.AddLiteralCharAdvance();

        if (AsciiAlphaToLower(this.c0_) === 'x') {
          this.AddLiteralCharAdvance();
          kind = HEX;
          if (!this.ScanHexDigits()) return 'TOKEN:ILLEGAL';
        } else if (AsciiAlphaToLower(this.c0_) === 'o') {
          this.AddLiteralCharAdvance();
          kind = OCTAL;
          if (!this.ScanOctalDigits()) return 'Token::ILLEGAL';
        } else if (AsciiAlphaToLower(this.c0_) === 'b') {
          this.AddLiteralCharAdvance();
          kind = BINARY;
          if (!this.ScanBinaryDigits()) return 'Token::ILLEGAL';
        } else if (IsOctalDigit(this.c0_)) {
          kind = IMPLICIT_OCTAL;
          // 这里的第二个参数kind是作为引用传入 JS没这个东西 只能改一下返回值
          if (!(kind = this.ScanImplicitOctalDigits(start_pos, kind))) return 'Token::ILLEGAL';
          if (kind === DECIMAL_WITH_LEADING_ZERO) as_start = false;
        } else if (IsNonOctalDecimalDigit(this.c0_)) {
          kind = DECIMAL_WITH_LEADING_ZERO;
        } else if (allow_harmony_numeric_separator() && UnicodeToAsciiMapping[this.c0_] === '_') {
          ReportScannerError(Location(source_pos(), source_pos() + 1), kZeroDigitNumericSeparator);
          return 'Token::ILLEGAL';
        }
      }

      // 到这里代表是普通的十进制数字
      if (IsDecimalNumberKind(kind)) {
        // 如果是0开头的十进制数字 则不会进入这里
        if (as_start) {
          let value = 0;
          /**
           * 这里value同样作为引用传入 JS没有引用修改了返回值
           * 由于0同样是假值 这里以null为非法标记
           */
          if ((value = this.ScanDecimalAsSmi(value)) === null) return 'Token::ILLEGAL';
          if (this.next().literal_chars.one_byte_literal().length <= 10
            && value <= Smi_kMaxValue
            && this.c0_ !== '.'
            && !IsIdentifierStart(this.c0_)) {
            this.next().smi_value_ = value;

            if (kind === DECIMAL_WITH_LEADING_ZERO) {
              this.octal_pos_ = new Location(start_pos, this.source_pos());
              this.octal_message_ = kStrictDecimalWithLeadingZero;
            }
            return 'Token::SMI';
          }
        }
        if (!this.ScanDecimalDigits()) return 'Token::ILLEGAL';
        if (UnicodeToAsciiMapping[this.c0_] === '.') {
          seen_period = true;
          this.AddLiteralCharAdvance();
          if (allow_harmony_numeric_separator() && UnicodeToAsciiMapping[this.c0_] === '_') return 'Token::ILLEGAL';
          if (!this.ScanDecimalDigits()) return 'Token::ILLEGAL';
        }
      }
    }
    // 大整数判断
    let is_bigint = false;
    if (UnicodeToAsciiMapping[this.c0_] === 'n' && !seen_period && IsValidBigIntKind(kind)) {
      // 这里根据长度快速判断大整数合法性
      const kMaxBigIntCharacters = BigInt_kMaxLengthBits / 4;
      let length = this.source_pos() - this.start_pos - (kind != DECIMAL ? 2 : 0);
      if (length > kMaxBigIntCharacters) return 'Token::ILLEGAL';

      is_bigint = true;
      this.Advance();
    }
    // 处理指数
    else if (AsciiAlphaToLower(this.c0_) === 'e') {
      if (!IsDecimalNumberKind(kind)) return 'Token::ILLEGAL';
      this.AddLiteralCharAdvance();
      if (!this.ScanSignedInteger()) return 'Token::ILLEGAL';
    }

    // ...

    if (kind === DECIMAL_WITH_LEADING_ZERO) {
      this.octal_pos_ = new Location(start_pos, this.source_pos());
      this.octal_message_ = kStrictDecimalWithLeadingZero
    }
    return is_bigint ? 'Token::BIGINT' : 'Token::NUMBER';
  }
  /**
   * 这是一个公共方法
   * 第一个参数代表进制
   * 第二个参数标记是否需要检验第一个数字
   */
  ScanDigitsWithNumericSeparators(predicate, is_check_first_digit) {
    if (is_check_first_digit && !predicate(this.c0_)) return false;

    let separator_seen = false;
    while(predicate(this.c0_) || UnicodeToAsciiMapping[this.c0_] === '_') {
      if (UnicodeToAsciiMapping[this.c0_] === '_') {
        this.Advance();
        // 连续两个下划线是不合法的
        if (UnicodeToAsciiMapping[this.c0_] === '_') {
          ReportScannerError(new Location(source_pos(), source_pos() + 1), kContinuousNumericSeparator);
          return false;
        }
        separator_seen = true;
        continue;
      }
      separator_seen = false;
      this.AddLiteralCharAdvance();
    }
    // 数字不能以下划线结尾
    if (separator_seen) {
      ReportScannerError(new Location(source_pos(), source_pos() + 1), kTrailingNumericSeparator);
      return false;
    }

    return true;
  }
  /**
   * 解析各个进制的数字
   * 基本上都是走同一个方法
   */
  ScanDecimalDigits() {
    if (allow_harmony_numeric_separator()) return this.ScanDigitsWithNumericSeparators(IsDecimalDigit, false);
    while(IsDecimalDigit(this.c0_)) this.AddLiteralCharAdvance();
    return true;
  }
  ScanHexDigits() {
    if (allow_harmony_numeric_separator()) return this.ScanDigitsWithNumericSeparators(IsHexDigit, true);
    // 0x后面至少需要有一个数字
    if (!IsHexDigit(this.c0_)) return false;
    while(IsHexDigit(this.c0_)) this.AddLiteralCharAdvance();
    return true;
  }
  ScanOctalDigits() {
    if (allow_harmony_numeric_separator()) return this.ScanDigitsWithNumericSeparators(IsOctalDigit, true);
    // 0o后面至少需要有一个数字
    if (!IsOctalDigit(this.c0_)) return false;
    while(IsOctalDigit(this.c0_)) this.AddLiteralCharAdvance();
    return true;
  }
  ScanBinaryDigits() {
    if (allow_harmony_numeric_separator()) return this.ScanDigitsWithNumericSeparators(IsBinaryDigit, true);
    // 0b后面至少需要有一个数字
    if (!IsBinaryDigit(this.c0_)) return false;
    while(IsBinaryDigit(this.c0_)) this.AddLiteralCharAdvance();
    return true;
  }
  ScanImplicitOctalDigits(start_pos, kind) {
    kind = IMPLICIT_OCTAL;
    while(true) {
      if (IsNonOctalDecimalDigit(this.c0_)) {
        kind = DECIMAL_WITH_LEADING_ZERO;
        // 应该返回true
        return DECIMAL_WITH_LEADING_ZERO;
      }
      if (!IsOctalDigit(this.c0_)) {
        this.octal_pos_ = new Location(start_pos, this.source_pos());
        // this.octal_message_ = kStrictOctalLiteral;
        // 应该返回true
        return IMPLICIT_OCTAL;
      }
      this.AddLiteralCharAdvance();
    }
  }
  ScanDecimalAsSmi(value) {
    if (allow_harmony_numeric_separator()) return this.ScanDecimalAsSmiWithNumericSeparators(value);
    while(IsDecimalDigit(this.c0_)) {
      value = 10 * value + (String.fromCharCode(this.c0_) - '0');
      let first_char = this.c0_;
      this.Advance();
      this.AddLiteralChar(first_char);
    }
    // 这里应该是true
    return value;
  }
  ScanDecimalAsSmiWithNumericSeparators(value) {
    let separator_seen = false;
    while(IsDecimalDigit(this.c0_) || UnicodeToAsciiMapping[this.c0_] === '_') {
      if (UnicodeToAsciiMapping[this.c0_] === '_') {
        this.Advance();
        if (UnicodeToAsciiMapping[this.c0_] === '_') {
          ReportScannerError(new Location(source_pos(), source_pos() + 1), kContinuousNumericSeparator);
          return null;
        }
        separator_seen = true;
        continue;
      }
      separator_seen = false;
      value = 10 * value + (String.fromCharCode(this.c0_) - '0');
      let first_char = this.c0_;
      this.Advance();
      this.AddLiteralChar(first_char);
    }
    if (separator_seen) {
      ReportScannerError(new Location(source_pos(), source_pos() + 1), kTrailingNumericSeparator);
      return null;
    }
    return value;
  }
  // 处理指数
  ScanSignedInteger() {
    if (UnicodeToAsciiMapping[this.c0_] === '+' || UnicodeToAsciiMapping[this.c0_] === '-') this.AddLiteralCharAdvance();
    if (!IsDecimalDigit(this.c0_)) return false;
    return this.ScanDecimalDigits();
  }

  /**
   * 解析标识符相关
   * 标识符的解析也用到了literal类
   */
  ScanIdentifierOrKeyword() {
    this.next().literal_chars.Start();
    return this.ScanIdentifierOrKeywordInner();
  }
  ScanIdentifierOrKeywordInner() {
    /**
     * 两个布尔类型的flag 
     * 一个标记转义字符 一个标记关键词
     */
    let escaped = false;
    let can_be_keyword = true;
    if (this.c0_ < kMaxAscii) {
      // 转义字符以'\'字符开头
      if (this.c0_ !== '\\') {
        let scan_flags = character_scan_flags[this.c0_];
        // 这个地方比较迷 没看懂
        scan_flags >>= 1;
        this.AddLiteralChar(this.c0_);
        this.AdvanceUntil((c0) => {
          // 当某个字符的Ascii值大于127 进入慢解析
          if (c0 > kMaxAscii) {
            scan_flags |= kIdentifierNeedsSlowPath;
            return true;
          }
          // 叠加每个字符的bitmap
          let char_flags = character_scan_flags[c0];
          scan_flags |= char_flags;
          // 用bitmap判断是否结束
          if (TerminatesLiteral(char_flags)) {
            return true;
          } else {
            this.AddLiteralChar(c0);
            return false;
          }
        });
        // 基本上都是进这里
        if (!IdentifierNeedsSlowPath(scan_flags)) {
          if (!CanBeKeyword(scan_flags)) return 'Token::IDENTIFIER';
          // 源码返回一个新的vector容器 这里简单处理成一个字符串
          let str = this.next().literal_chars.one_byte_literal();
          return this.KeywordOrIdentifierToken(str, str.length);
        }
        can_be_keyword = CanBeKeyword(scan_flags);
      } else {
        escaped = true;
        // let c = this.ScanIdentifierUnicodeEscape();
        // 合法变量以大小写字母_开头
        // if (c === '\\' || !IsIdentifierStart(c)) return 'Token::ILLEGAL';
        // this.AddLiteralChar(c);
        // can_be_keyword = CharCanBeKeyword(c);
      }
    }
    // 逻辑同上 进这里代表首字符Ascii值就过大 暂时不实现这种特殊情况了
    return ScanIdentifierOrKeywordInnerSlow(escaped, can_be_keyword);
  }
  ScanIdentifierOrKeywordInnerSlow() {}
  // 跳到另外一个文件里实现
  KeywordOrIdentifierToken(str, len) {
    return PerfectKeywordHash.GetToken(str, len);
  }
  ScanIdentifierUnicodeEscape() {
  }
  /**
   * 解析字符串相关
   */
  ScanString() {
    // 保存当前字符串的标记符号 ' 或 "
    let quote = this.c0_;
    this.next().literal_chars.Start();
    while(true) {
      this.c0_ = this.AdvanceUntil((c0) => {
        /**
         * 代表当前字符可能是一个结束符 这里简化了判断 源码如下
         * uint8_t char_flags = character_scan_flags[c0];
         * if (MayTerminateString(char_flags)) return true;
         */
        if (["\'", "\""].includes(UnicodeToAsciiMapping[c0])) return true;
        this.AddLiteralChar(c0);
        return false;
      });
      /**
       * 特殊符号直接前进一格
       */
      while(UnicodeToAsciiMapping[this.c0_] === '\\') {
        this.Advance();
      }
      /**
       * 遇到结束的标记代表解析结束
       */
      if (this.c0_ === quote) {
        this.Advance();
        return 'Token::STRING';
      }
      this.AddLiteralChar(this.c0_);
    }
  }

  /**
   * 解析模板字符串
   * 进来之前已经将'`'符号消费了
   * TEMPLATE_SPAN: `LiteralChars* ${、} LiteralChars* ${
   * TEMPLATE_TAIL: } LiteralChar* `
   */
  ScanTemplateSpan() {
    let result = 'Token::TEMPLATE_SPAN';
    this.next().literal_chars.Start();
    this.next().raw_literal_chars.Start();
    const capture_raw = true;
    while(true) {
      // ``代表空字符串 直接标记为结尾
      if(this.char === '`') {
        this.Advance();
        result = 'Token::TEMPLATE_TAIL';
        break;
      }
      // `xxx${ 返回 
      else if(this.char === '$' && this.Peek() === '{') {
        this.Advance();
        this.Advance();
        break;
      }
      // `\x 转移字符
      else if(this.char === '\\') {
        this.Advance();
        if(capture_raw) this.AddRawLiteralChar('\\');
        if(IsLineTerminator(this.c0_)) {
          let lastChar = String.fromCharCode(this.c0_);
          this.Advance();
          if(lastChar === '\r') {
            if(this.c0_ === '\n') this.Advance();
            lastChar = '\n';
          }
          if(capture_raw) this.AddRawLiteralChar(lastChar);
        }
      }
      // 异常情况 
      else if(this.c0_ < 0) {
        break;
      }
      // `xx 普通字符串 
      else {
        this.Advance();
        // \r、\r\n统一被处理为\n
        if(this.char === '\r') {
          // \r\n
          if(this.char === '\n') this.Advance();
          this.char = '\n';
        }
        if(capture_raw) this.AddRawLiteralChar(this.c0_);
        this.AddLiteralChar(this.c0_);
      }
    }
    this.next().location.end_pos = this.source_pos();
    this.next().token = result;

    return result;
  }
  ScanTemplateContinuation() {
    return this.ScanTemplateSpan();
  }
  
  /**
   * 解析保留关键词
   */
  ScanPrivateName() {
    this.next().literal_chars.Start();
    if(!IsIdentifierStart(this.Peek())) throw new Error('Token::ILLEGAL');
    this.AddLiteralCharAdvance();
    let token = this.ScanIdentifierOrKeywordInner();
    return token === 'Token::ILLEGAL' ? 'Token::ILLEGAL' : 'Token::PRIVATE_NAME;';
  }

  /**
   * 非Token解析方法
   * 处理标识符
   */
  CurrentSymbol(ast_value_factory) {
    if (this.is_literal_one_byte()) {
      return ast_value_factory.GetOneByteString(this.literal_one_byte_string());
    }
  }
  NextSymbol(ast_value_factory) {
    if(this.is_next_literal_one_byte()) {
      return ast_value_factory.GetOneByteString(this.next_literal_one_byte_string());
    }
  }
  CurrentRawSymbol(ast_value_factory) {
    if (this.is_raw_literal_one_byte()) {
      return ast_value_factory.GetOneByteString(this.raw_literal_one_byte_string());
    }
  }

  is_literal_one_byte() {
    return this.current().literal_chars.is_one_byte();
  }
  is_next_literal_one_byte() {
    return this.next().literal_chars.is_one_byte();
  }
  is_raw_literal_one_byte() {
    return this.current().raw_literal_chars.is_one_byte();
  }

  /**
   * 太麻烦 不实现了
   * 返回一个doubleValue
   * 如果是NaN 则是一个大整数
   */
  DoubleValue() {
    return Number(this.literal_one_byte_string()) || (0xfff << 51);
    // return StringToDouble(this.literal_one_byte_string(), ALLOW_HEX | ALLOW_OCTAL | ALLOW_IMPLICIT_OCTAL | ALLOW_BINARY);
  }

  /**
   * @returns {String} 当前Token的字符串
   */
  literal_one_byte_string() {
    return this.current().literal_chars.one_byte_literal();
  }
  next_literal_contains_escapes() {
    return this.LiteralContainsEscapes(this.next());
  }
  next_literal_one_byte_string() {
    return this.next().literal_chars.one_byte_literal();
  }
  NextLiteralExactlyEquals(string) {
    return this.next_literal_one_byte_string() === string;
  }

  raw_literal_one_byte_string() {
    return this.current().raw_literal_chars.one_byte_literal();
  }
}

const kNoBookmark = Number.MAX_SAFE_INTEGER - 1;

export class BookmarkScope {
  constructor(scanner) {
    this.scanner_ = scanner;
    this.bookmark_ = kNoBookmark;
  }
}