# Third-party notices

## SMS protocol references and official CAPTCHA

The SMS implementation independently follows publicly visible mainland app
endpoints/field contracts, with protocol research reference to
[IKUNHEIHIE/miyoushe-checkin](https://github.com/IKUNHEIHIE/miyoushe-checkin),
notably its backend upstream.ts. Its license has not been verified here;
this notice does not assert a license grant for that project, and no upstream
backend or service is bundled/executed by this plugin.
Reference source SHA256: `332a0b145b524a334d7aef42c54a04d26b574442f0bf7dde559e1962d16c973d`.

Official Geetest GT4/GT3 loaders are requested at runtime, only for manual
verification inside an opaque sandbox:
- https://static.geetest.com/v4/gt4.js
- https://static.geetest.com/static/tools/gt.js

They are not vendored or redistributed under this plugin's MIT license.
Their own provider terms and availability apply. No CAPTCHA-solving service,
bypass, third-party SDK account agent, or QR renderer is included.


## MihoyoBBSTools

Community endpoint headers, constants, and account balance field mapping in
`lib/community.js` were adapted from [MihoyoBBSTools](https://github.com/Womsxd/MihoyoBBSTools),
using the user-provided local copy. No Python code is executed by this plugin.
The community implementation deliberately excludes reading, liking, sharing,
and CAPTCHA-solving behavior.

MIT License

Copyright (c) 2021-2022 Womsxd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
