const { Duplex, Readable } = require('stream')
const crc16 = require('./crc16')

const NUL = 0x00
const SOH = 0x01
const STX = 0x02
const EOT = 0x04
const ACK = 0x06
const NAK = 0x15
const CAN = 0x18
const CRC = 0x43

const SOH_DATA_LENGTH = 128
const STX_DATA_LENGTH = 1024

const RECEIVE_TIMEOUT = 5000
const PURGE_TIMEOUT = 2000
const RETRY_LIMIT = 5

class TimeoutError extends Error {}

function zeros (buffer, offset, length) {
  for (let i = offset; i < offset + length; i++) {
    if (buffer[i]) return false
  }

  return true
}

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

    this._buffer = Buffer.alloc(0)
    this._cb = null
    this._onreadable = null
  }

  createReadStream () {
    const self = this
    let headerBlock = true
    let blockCount = 0
    let eotCount = 0
    let canCount = 0
    let tries = 0
    let fileLength = 0

    const send = (...b) => {
      this.push(Buffer.from(b))
    }

    const nak = async () => {
      tries++
      if (tries >= RETRY_LIMIT) throw new Error('nak limit reached')
      await this._purge()
      send(NAK)
    }

    const ack = () => {
      tries = 0
      send(ACK)
    }

    const receiver = async function * () {
      send(CRC)

      while (true) {
        const [b] = await self._receive(1, RECEIVE_TIMEOUT)
        let length = 0

        if (b !== EOT) eotCount = 0
        if (b !== CAN) canCount = 0

        switch (b) {
          case SOH:
            length = SOH_DATA_LENGTH
            break
          case STX:
            length = STX_DATA_LENGTH
            break
          case EOT:
            if (eotCount === 0) {
              eotCount++
              await nak()
              continue
            } else {
              ack()
              return
            }
          case CAN:
            canCount++
            ack()
            if (canCount === 0) continue
            else return
          default:
            await nak()
            continue
        }

        const block = await self._receive(length + 4, RECEIVE_TIMEOUT)
        const [n, m] = block

        if (n + m !== 255 || n !== blockCount) {
          await nak()
          continue
        }

        const checksum = block.readUInt16BE(block.length - 2)

        if (checksum !== crc16(block, 2, block.length - 4)) {
          await nak()
          continue
        }

        if (headerBlock && zeros(block, 2, block.length - 4)) {
          stream.emit('file', { length: 0 })
          self.emit('file', { length: 0 }, stream)
          ack()
          return
        } else if (headerBlock) {
          const i = block.indexOf(NUL, 2)
          const name = block.toString('utf8', 2, i)
          const j = block.indexOf(NUL, i + 1)
          fileLength = block.toString('utf8', i + 1, j)
          fileLength = parseInt(fileLength, 10)

          stream.emit('file', { name, length: fileLength })
          self.emit('file', { name, length: fileLength }, stream)

          ack()
          send(CRC)
        } else {
          const available = Math.min(block.length - 4, fileLength)
          const data = block.slice(2, available + 2)
          if (data.length) yield data
          fileLength -= data.length
          ack()
        }

        headerBlock = false
        blockCount++
      }
    }

    const stream = Readable.from(receiver())
    return stream
  }

  _read (n) {}

  _write (data, encoding, cb) {
    this._cb = cb
    this._buffer = Buffer.concat([this._buffer, data])
    if (this._onreadable) this._onreadable(this._buffer, cb)
  }

  _destroy (err, cb) {
    if (this._onreadable) this._onreadable(null, cb, err)
    else cb(err)
  }

  async _purge () {
    try {
      while (true) {
        this._buffer = Buffer.alloc(0)
        await this._receive(1, PURGE_TIMEOUT)
      }
    } catch (err) {
      if (err instanceof TimeoutError) return
      throw err
    }
  }

  _receive (n, t) {
    return new Promise((resolve, reject) => {
      let timeout = null

      const onreadable = (buffer, cb, err) => {
        clearTimeout(timeout)

        if (buffer == null) {
          reject(err || new Error('unexpected end of stream'))
          cb()
        } else if (buffer.length < n) {
          timeout = setTimeout(() => {
            this._onreadable = null
            reject(new TimeoutError('receive timed out'))
          }, t)

          this._onreadable = onreadable
          if (cb) cb()
        } else {
          this._onreadable = null
          const data = buffer.slice(0, n)
          this._buffer = buffer.slice(n)
          resolve(data)
        }
      }

      onreadable(this._buffer, () => {
        if (this._cb) this._cb()
        this._cb = null
      })
    })
  }
}

exports.YModemSenderStream = YModemSenderStream
exports.YModemReceiverStream = YModemReceiverStream
