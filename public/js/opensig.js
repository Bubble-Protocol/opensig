// Copyright (c) 2023 Bubble Protocol
// Distributed under the MIT software license, see the accompanying
// file LICENSE or http://www.opensource.org/licenses/mit-license.php.

const SIG_DATA_VERSION = '00';
const SIG_DATA_ENCRYPTED_FLAG = 128;
const SIG_DATA_TYPE_STRING = 0;
const SIG_DATA_TYPE_BYTES = 1;


/**
 * Creates an OpenSig document from a hash, allowing it to be signed and verified.  
 */
class Document {

  documentHash = undefined;
  hashes = undefined;

  constructor(hash) {
    this.sign = this.sign.bind(this);
    this.verify = this.verify.bind(this);
    this.setDocumentHash = this.setDocumentHash.bind(this);
    if (hash !== undefined) this.setDocumentHash(hash);
  }

  /**
   * Signs the document with the next available signature hash and the given data.
   * @param {*} data 
   * @returns {Object} containing 
   *    txHash: blockchain transaction hash
   *    signatory: signatory of the transaction
   *    signature: the signature hash published
   *    confirmationInformer: Promise that resolves when the transaction has been confirmed
   */
  async sign(data) {
    if (!window.crypto || !window.crypto.subtle) throw new Error("Browser not supported: missing crypto capability")
    if (this.hashes === undefined) throw new Error("Must verify before signing");
    return this.hashes.next()
      .then(signature => { 
        return _publishSignature(signature, data, this.encryptionKey);
      })
      .catch(error => {
        this.hashes.reset(this.hashes.currentIndex()-1);
        throw error;
      });
  }

  /**
   * Retrieves all signatures on the current blockchain for this document hash.
   * 
   * @returns Array of signature events or empty array if none
   * @throws BlockchainNotSupportedError
   */
  async verify() {
    if (!window.crypto || !window.crypto.subtle) throw new Error("Browser not supported: missing crypto capability");
    console.trace("verifying hash", _buf2hex(this.documentHash));
    return _discoverSignatures(this.documentHash, this.encryptionKey)
      .then(result => {
        this.hashes = result.hashes;
        return result.signatures;
      });
  }

  async setDocumentHash(hash) {
    this.documentHash = hash;
    this.encryptionKey = await _getEncryptionKey(hash);
  }

}


/**
 * Creates an OpenSig document from a file, allowing it to be signed and verified.
 */
class File extends Document {

  file = undefined;
  document = undefined;

  constructor(file) {
    super(undefined);
    this.file = file;
  }

  /**
   * Retrieves all signatures on the current blockchain for this file.
   * 
   * @param {File} file the file to verify
   * @returns Array of signature events or empty array if none
   * @throws BlockchainNotSupportedError
   */
  async verify() {
    if (!window.crypto || !window.crypto.subtle) throw new Error("Browser not supported: missing crypto capability");
    if (this.documentHash !== undefined) return super.verify();
    console.trace("verifying file", this.file.name);
    return hashFile(this.file)
      .then(this.setDocumentHash)
      .then(super.verify.bind(this));
  }

}


//
// Signing functions
//

/**
 * Constructs a transaction to publish the given signature transaction to the blockchain's registry contract.
 * Returns an object containing the transaction hash, signatory, signature, and a Promise to resolve when confirmed.
 */ 
function _publishSignature(signatureAsArr, data, encryptionKey) {
  const network = getBlockchain();
  if (network === undefined) throw new BlockchainNotSupportedError();
  const web3 = new Web3(window.ethereum);

  const contract = new web3.eth.Contract(network.contract.abi, network.contract.address);
  const signatory = window.ethereum.selectedAddress;
  const signature = _buf2hex(signatureAsArr[0]);  

  return _encodeData(data, encryptionKey)
    .then(encodedData => {
      console.trace("publishing signature:", signature, "with data", encodedData);
      const transactionParameters = {
        to: network.contract.address,
        from: signatory,
        value: 0,
        data: contract.methods.registerSignature(signature, encodedData).encodeABI(), 
      };
      return ethereum.request({ method: 'eth_sendTransaction', params: [transactionParameters] })
        .then(txHash => { 
          return { 
            txHash: txHash, 
            signatory: signatory,
            signature: signature,
            confirmationInformer: _confirmTransaction(network, web3, txHash) 
          };
        });
    });
}


/**
 * Returns a promise to resolve when the given transaction hash has been confirmed bly the blockchain network.
 * Rejects if the transaction reverted.
 */
function _confirmTransaction(network, web3, txHash) {
  return new Promise( (resolve, reject) => {

    function checkTxReceipt(txHash, interval, resolve, reject) {
      web3.eth.getTransactionReceipt(txHash)
        .then(receipt => {
          if (receipt === null ) setTimeout(() => { checkTxReceipt(txHash, interval, resolve, reject) }, interval);
          else {
            if (receipt.status) resolve(receipt);
            else reject(receipt);
          }
        })
    }

    setTimeout(() => { checkTxReceipt(txHash, 1000, resolve, reject) }, network.network.blockTime); 
  })
}


//
// Verifying functions
//

/**
 * Queries the blockchain for signature events generated by the registry contract for the given document hash.
 */
async function _discoverSignatures(documentHash, encryptionKey) {
  const network = getBlockchain();
  if (network === undefined) throw new BlockchainNotSupportedError();
  const web3 = new Web3(window.ethereum);

  const signatureEvents = [];
  const chainSpecificDocumentHash = await hash(_concatBuffers(Uint8Array.from(''+network.network.chain), documentHash))
  const hashes = new HashIterator(chainSpecificDocumentHash);
  let lastSignatureIndex = -1;

  const MAX_SIGS_PER_DISCOVERY_ITERATION = 10;

  async function _discoverNext(n) {
    const eSigs = await hashes.next(n);
    const strEsigs = eSigs.map(s => {return _buf2hex(s)});
    console.trace("querying the blockchain for signatures: ", strEsigs);

    return web3.eth.getPastLogs({
        address: network.contract.address,
        fromBlock: network.contract.creationBlock || 'earliest',
        topics: [null, null, strEsigs]
      })
      .then(events => {
        console.trace("found events:", events);
        return Promise.all(events.map(e => _decodeSignatureEvent(e, encryptionKey)));
      })
      .then(parsedEvents => {
         signatureEvents.push(...parsedEvents);

        // update state index of most recent signature
        parsedEvents.forEach(e => {
          const sigNumber = hashes.indexOf(e.signature);
          if (sigNumber > lastSignatureIndex) lastSignatureIndex = sigNumber;
        });
        
        // discover more signatures if necessary
        if (parsedEvents.length !== MAX_SIGS_PER_DISCOVERY_ITERATION) {
          hashes.reset(lastSignatureIndex); // leave the iterator at the last publishes signature
          return { hashes: hashes, signatures: signatureEvents };
        }
        return _discoverNext(MAX_SIGS_PER_DISCOVERY_ITERATION);
      });

  }

  return _discoverNext(MAX_SIGS_PER_DISCOVERY_ITERATION);

}

/**
 * Transforms a blockchain event into an OpenSig signature object.
 */
async function _decodeSignatureEvent(event, encryptionKey) {
  const web3 = new Web3(window.ethereum);
  const decodedEvent = web3.eth.abi.decodeLog(
    [ { "indexed": false, "internalType": "uint256", "name": "time", "type": "uint256" }, { "indexed": true, "internalType": "address", "name": "signer", "type": "address" }, { "indexed": true, "internalType": "bytes32", "name": "signature", "type": "bytes32" }, { "indexed": false, "internalType": "bytes", "name": "data", "type": "bytes" } ],
    event.data,
    event.topics.slice(1)
  )
  return {
    time: decodedEvent.time,
    signatory: decodedEvent.signer,
    signature: decodedEvent.signature,
    data: await _decodeData(decodedEvent.data, encryptionKey)
  }
}


//
// Signature Data encoders - encode and decode signature data in accordance with OpenSig standard v0.1
//

async function _encodeData(data, encryptionKey) {
  if (data.content === undefined || data.content === '') return '0x';
  let type = data.encrypted ? SIG_DATA_ENCRYPTED_FLAG : 0;
  let encData = '';

  switch (data.type) {
    case 'string':
      type += SIG_DATA_TYPE_STRING;
      encData = unicodeStrToHex(data.content);
      break;

    case 'hex':
      type += SIG_DATA_TYPE_BYTES;
      encData = data.slice(0,2) === '0x' ? data.slice(2) : data;
      break;

    default:
      throw new Error("encodeData: invalid type '"+data.type+"'");
  }

  const typeStr = ('00' + type.toString(16)).slice(-2);
  const prefix = '0x'+SIG_DATA_VERSION + typeStr;
  if (data.encrypted) return _encrypt(encData, encryptionKey).then(encryptedData => { return '0x'+SIG_DATA_VERSION + typeStr + encryptedData })
  else return prefix + encData;
}

async function _decodeData(encData, encryptionKey) {
  if (!encData || encData === '') return {type: 'none'}
  if (encData.length < 6) return {type: "invalid", content: "data is < 6 bytes"}
  const version = encData.slice(2,4);
  const typeField = parseInt(encData.slice(4,6), 16);
  const encrypted = typeField & SIG_DATA_ENCRYPTED_FLAG ? true : false;
  const type = typeField & ~SIG_DATA_ENCRYPTED_FLAG;
  const data = {
    version: version,
    encrypted: encrypted
  }
  
  let sigData = encData.slice(6);
  if (encrypted && sigData.length > 0) {
    try {
      sigData = await _decrypt(sigData, encryptionKey);
    }
    catch(error) {
      console.trace("failed to decrypt signature data:", error.message);
      sigData = '';
    }
  }

  switch (type) {
    case SIG_DATA_TYPE_STRING:
      data.type = 'string';
      data.content = unicodeHexToStr(sigData);
      break;
    
    case SIG_DATA_TYPE_BYTES:
      data.type = 'hex';
      data.content = '0x'+sigData
      break;

    default:
      data.type = 'invalid';
      data.content = "unrecognised type: "+type+" (version="+version+")";
  }

  return data;
}


//
// Hashing utils
//

/**
 * Hashes the given data buffer
 * @param {Buffer} data 
 * @returns 32-byte hash as ArrayBuffer
 */
function hash(data) {
  return window.crypto.subtle.digest('SHA-256', data);
}

/**
 * Hashes the given File
 * @param {File} file the file to hash
 * @returns 32-byte hash as ArrayBuffer
 */
async function hashFile(file) {
  return readFile(file)
    .then(data => {
      return window.crypto.subtle.digest('SHA-256', data);
    })
}

/**
 * Generates the deterministic sequence of signature hashes for a document hash in accordance with OpenSig standard v0.1.
 * Use `next` to retrieve the next `n` hashes.  The iterator will only generate hashes when the `next` function is
 * called.
 */
class HashIterator {

  hashes = [];
  hashPtr = -1;

  constructor(documentHash) {
    this.documentHash = documentHash;
  }

  async next(n=1) {
    if (this.hashes.length === 0) this.hashes.push(await hash(this.documentHash));
    for (let i=this.hashes.length; i<=this.hashPtr+n; i++) {
      this.hashes.push(await hash(_concatBuffers(this.documentHash, this.hashes[i-1])));
    }
    return this.hashes.slice(this.hashPtr+1, (this.hashPtr+=n)+1);
  }

  current() { return this.hashPtr >= 0 ? this.hashes(this.hashPtr) : undefined }

  currentIndex() { return this.hashPtr }

  indexAt(i) { return i < this.hashes.length ? this.hashes[i] : undefined }

  indexOf(hash) { return this.hashes.map(h => { return _buf2hex(h) }).indexOf(hash) }

  reset(n=0) { this.hashPtr = n }

  size() { return this.hashPtr }

}


//
// Encryption utils
//

async function _getEncryptionKey(hashAsBuf) {
  return window.crypto.subtle.importKey("raw", hashAsBuf, {name: 'AES-GCM'}, true, ['encrypt', 'decrypt']);
}

async function _encrypt(data, key) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  return _buf2hex(_concatBuffers(iv, await window.crypto.subtle.encrypt({name: 'AES-GCM', iv: iv}, key, _hexToBuf(data))), false);
}

async function _decrypt(data, key) {
  const buf = _hexToBuf(data);
  return _buf2hex(await window.crypto.subtle.decrypt({name: 'AES-GCM', iv: buf.slice(0,12)}, key, buf.slice(12)), false)
}


//
// Utility functions
//

function readFile(file) {
  return new Promise( (resolve, reject) => {
    var reader = new FileReader();
    reader.onload = () => { resolve(reader.result) };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  })
}


function _buf2hex(buffer, prefix0x=true) {
  return (prefix0x ? '0x' : '')+[...new Uint8Array(buffer)]
      .map(x => x.toString(16).padStart(2, '0'))
      .join('');
}

function _hexToBuf(hex) {
  return Uint8Array.from(hex.replace('0x','').match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
}

function _concatBuffers(buffer1, buffer2) {
  var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp.buffer;
}

function unicodeStrToHex(str) {
  var result = "";
  for (let i=0; i<str.length; i++) {
    const hex = str.charCodeAt(i).toString(16);
    result += ("000"+hex).slice(-4);
  }
  return result
}

function unicodeHexToStr(str) {
  var hexChars = str.replace('0x','').match(/.{1,4}/g) || [];
  var result = "";
  for(let j = 0; j<hexChars.length; j++) {
    result += String.fromCharCode(parseInt(hexChars[j], 16));
  }
  return result;
}


//
// Errors
//

class BlockchainNotSupportedError extends Error {
  constructor() {
    super("Blockchain not supported");
  }
}


//
// Module exports
//

export const opensig = {
  File: File,
  Document: Document,
  hash: hash,
  hashFile: hashFile,
  HashIterator: HashIterator,
  errors: {
    BlockchainNotSupportedError: BlockchainNotSupportedError
  }
}
