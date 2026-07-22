// 壳内跨模块小工具(自给自足,不为一个函数引第三方 crate)。

/// 百分号编码:RFC 3986 unreserved(字母/数字/-_.~)之外的字节一律 %XX。
/// query 参数与 fragment 通用(main.rs 错误页 hash、monkeycode 云端 API 共用,
/// 之前两处各自手写一份逐字节相同的实现,合并于此)。
pub fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_unreserved_passthrough() {
        assert_eq!(urlencode("AZaz09-_.~"), "AZaz09-_.~");
    }

    #[test]
    fn urlencode_escapes_reserved_and_utf8() {
        assert_eq!(urlencode("a b&c=d"), "a%20b%26c%3Dd");
        // 多字节 UTF-8 按字节逐个转义
        assert_eq!(urlencode("中"), "%E4%B8%AD");
    }
}
