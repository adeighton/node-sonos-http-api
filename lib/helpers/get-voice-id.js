
function getVoiceName(str) {
    for (let i = str.length - 1; i > 0; i--) {
        if (str[i] >= 'A' && str[i] <= 'Z') {
            return str.substring(0, i);
        }
    }
    // If the first character is a capital letter, return the whole string
    if (str[0] >= 'A' && str[0] <= 'Z') {
        return str;
    }
    // If no capital letter is found, return the whole string
    return str;
}

function getVoiceEngine(str) {
    for (let i = str.length - 1; i > 0; i--) {
        if (str[i] >= 'A' && str[i] <= 'Z') {
            return str.substring(i);
        }
    }
    // If the first character is a capital letter, return an empty string
    if (str[0] >= 'A' && str[0] <= 'Z') {
        return '';
    }
    // If no capital letter is found, return an empty string
    return '';
}

// Test cases
// console.log(getVoiceName("fooBar")); // Output: "foo"
// console.log(getVoiceEngine("fooBar")); // Output: "Bar"
// console.log(getVoiceName("FooBar")); // Output: "Foo"
// console.log(getVoiceEngine("FooBar")); // Output: "Bar"
// console.log(getVoiceName("fooBarBar")); // Output: "fooBar"
// console.log(getVoiceEngine("fooBarBar")); // Output: "Bar"
// console.log(getVoiceName("foobar")); // Output: "foobar"
// console.log(getVoiceEngine("foobar")); // Output: ""
// console.log(getVoiceName("Foobar")); // Output: "Foobar"
// console.log(getVoiceEngine("Foobar")); // Output: ""
// console.log(getVoiceName("Bar")); // Output: "Bar"
// console.log(getVoiceEngine("Bar")); // Output: ""

module.exports = {
    getVoiceName,
    getVoiceEngine
  };