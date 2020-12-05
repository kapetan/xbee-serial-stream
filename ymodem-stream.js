const { Duplex } = require('stream')
const crc16 = require('./crc16')

const NUL = Buffer.of(0x00)
const SOH = Buffer.of(0x01)
const STX = Buffer.of(0x02)
const EOT = Buffer.of(0x04)
const ACK = Buffer.of(0x06)
const NAK = Buffer.of(0x15)
const CAN = Buffer.of(0x18)
const CRC = Buffer.of(0x43)

class YModemSenderStream extends Duplex {
  constructor (options) {
    super()
  }

  createWriteStream (filename, options) {

  }

  _read (n) {}

  _write (data, encoding, cb) {

  }
}

class YModemReceiverStream extends Duplex {
  constructor (options) {
    super()

    this.readable = null
  }

  createReadStream () {
    this.push(CRC)
  }

  _read () {}

  _write (data, encoding, cb) {

  }
}

exports.YModemSenderStream = YModemSenderStream
exports.YModemReceiverStream = YModemReceiverStream
