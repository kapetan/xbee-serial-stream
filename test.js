const test = require('tape')
const DeviceStream = require('.')

test('command mode', t => {
  const device = new DeviceStream()

  device.on('data', data => {
    t.deepEqual(data, Buffer.from('+++'))
    t.end()
  })
})

test('get setting command', t => {
  const device = new DeviceStream()

  device.once('data', data => {
    t.deepEqual(data, Buffer.from('+++'))
    device.write('OK\r')

    device.once('data', data => {
      t.deepEqual(data, Buffer.from('ATTT\r'))
      device.write('VALUE\r')
    })
  })

  device.command('TT')
    .then(response => {
      t.deepEqual(response, ['VALUE'])
      t.end()
    })
})

test('get setting command preceded by garbage', t => {
  const device = new DeviceStream()

  device.once('data', data => {
    t.deepEqual(data, Buffer.from('+++'))
    device.write('test\r')
    device.write('testOK\r')

    device.once('data', data => {
      t.deepEqual(data, Buffer.from('ATTT\r'))
      device.write('VALUE\r')
    })
  })

  device.command('TT')
    .then(response => {
      t.deepEqual(response, ['VALUE'])
      t.end()
    })
})

test('get multi line setting command', t => {
  const device = new DeviceStream()

  device.once('data', data => {
    t.deepEqual(data, Buffer.from('+++'))
    device.write('OK\r')

    device.once('data', data => {
      t.deepEqual(data, Buffer.from('ATTT\r'))
      device.write('VALUE_1\r')
      device.write('VALUE_2\r\r')
    })
  })

  device.command('TT', null, '')
    .then(response => {
      t.deepEqual(response, ['VALUE_1', 'VALUE_2'])
      t.end()
    })
})

test('set setting command', t => {
  const device = new DeviceStream()

  device.once('data', data => {
    t.deepEqual(data, Buffer.from('+++'))
    device.write('OK\r')

    device.once('data', data => {
      t.deepEqual(data, Buffer.from('ATTT VALUE\r'))
      device.write('DONE\r')
    })
  })

  device.command('TT', 'VALUE')
    .then(response => {
      t.deepEqual(response, ['DONE'])
      t.end()
    })
})

test('command error', t => {
  const device = new DeviceStream()

  device.once('data', data => {
    t.deepEqual(data, Buffer.from('+++'))
    device.write('OK\r')

    device.once('data', data => {
      t.deepEqual(data, Buffer.from('ATTT\r'))
      device.write('ERROR\r')
    })
  })

  device.command('TT')
    .catch(err => {
      t.match(err.message, /ERROR/)
      t.end()
    })
})

test('create read stream', t => {
  const device = new DeviceStream()
  const events = []

  device.once('data', data => {
    t.deepEqual(data, Buffer.from('+++'))
    device.write('OK\r')

    device.once('data', data => {
      t.deepEqual(data, Buffer.from('ATFS GET /flash/test.txt\r'))

      device.write('Sending file with YMODEM...\r')

      device.once('data', data => {
        t.deepEqual(data, Buffer.from('C'))

        device.write(Buffer.concat([
          Buffer.of(0x01, 0x00, 0xff),
          Buffer.from('/flash/test.txt'),
          Buffer.of(0x00),
          Buffer.from('5'),
          Buffer.alloc(111),
          Buffer.of(0xde, 0x17)
        ]))

        device.once('data', data => {
          t.deepEqual(data, Buffer.of(0x06))

          device.once('data', data => {
            t.deepEqual(data, Buffer.from('C'))

            device.write(Buffer.concat([
              Buffer.of(0x02, 0x01, 0xfe),
              Buffer.from('hello'),
              Buffer.alloc(1019).fill(0x1a),
              Buffer.of(0xb8, 0x5a)
            ]))

            device.once('data', data => {
              t.deepEqual(data, Buffer.of(0x06))

              device.write(Buffer.of(0x04))

              device.once('data', data => {
                t.deepEqual(data, Buffer.of(0x15))

                device.write(Buffer.of(0x04))

                device.once('data', data => {
                  t.deepEqual(data, Buffer.of(0x06))

                  device.once('data', data => {
                    t.deepEqual(data, Buffer.from('C'))

                    device.write(Buffer.concat([
                      Buffer.of(0x01, 0x00, 0xff),
                      Buffer.alloc(130)
                    ]))

                    device.once('data', data => {
                      t.deepEqual(data, Buffer.of(0x06))

                      device.write('\rOK\r')

                      device.command('TT')
                        .then(response => {
                          t.deepEqual(response, ['VALUE'])
                          t.deepEqual(events, [
                            ['file', { name: '/flash/test.txt', length: 5 }],
                            ['data', Buffer.from('hello')],
                            ['end']
                          ])
                          t.end()
                        })

                      device.once('data', data => {
                        t.deepEqual(data, Buffer.from('ATTT\r'))
                        device.write('VALUE\r')
                      })
                    })
                  })
                })
              })
            })
          })
        })
      })
    })
  })

  const read = device.createReadStream('/flash/test.txt')

  read.on('file', file => {
    events.push(['file', file])
  })

  read.on('data', data => {
    events.push(['data', data])
  })

  read.on('end', () => {
    events.push(['end'])
  })
})

test('create write stream', t => {
  const device = new DeviceStream()

  device.once('data', data => {
    t.deepEqual(data, Buffer.from('+++'))
    device.write('OK\r')

    device.once('data', data => {
      t.deepEqual(data, Buffer.from('ATFS PUT /flash/test.txt\r'))

      device.write('Receiving file with YMODEM...\r')
      device.write('C')

      device.once('data', data => {
        t.deepEqual(data, Buffer.concat([
          Buffer.of(0x01, 0x00, 0xff),
          Buffer.from('/flash/test.txt'),
          Buffer.of(0x00),
          Buffer.from('5'),
          Buffer.alloc(111),
          Buffer.of(0xde, 0x17)
        ]))

        device.write(Buffer.of(0x06))

        device.once('data', data => {
          t.deepEqual(data, Buffer.concat([
            Buffer.of(0x02, 0x01, 0xfe),
            Buffer.from('hello'),
            Buffer.alloc(1019).fill(0x1a),
            Buffer.of(0xb8, 0x5a)
          ]))

          device.write(Buffer.of(0x06))

          device.once('data', data => {
            t.deepEqual(data, Buffer.of(0x04))

            device.write(Buffer.of(0x15))

            device.once('data', data => {
              t.deepEqual(data, Buffer.of(0x04))

              device.write(Buffer.of(0x06))
              device.write('C')

              device.once('data', data => {
                t.deepEqual(data, Buffer.concat([
                  Buffer.of(0x01, 0x00, 0xff),
                  Buffer.alloc(130)
                ]))

                device.write(Buffer.of(0x06))
                device.write('\rOK\r')

                device.command('TT')
                  .then(response => {
                    t.deepEqual(response, ['VALUE'])
                    t.end()
                  })

                device.once('data', data => {
                  t.deepEqual(data, Buffer.from('ATTT\r'))
                  device.write('VALUE\r')
                })
              })
            })
          })
        })
      })
    })
  })

  const write = device.createWriteStream('/flash/test.txt', 5)

  write.end('hello')
})
