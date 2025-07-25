import requests

headers = {
    'Content-Type': 'application/json',
}

json_data = {
    'script': 'INT. COFFEE SHOP - DAY\n\nANNA sips her coffee, lost in thought.\n\nMARK\nA penny for them?\n\nEXT. PARK - DAY\n\nAnna walks through the park. Leaves crunch under her feet. She checks her phone, then sighs.',
}

response = requests.post('https://script-ai-worker.femivideograph.workers.dev/process', headers=headers, json=json_data)


print(response.status_code)
print(response.text)
# Note: json_data will not be serialized by requests
# exactly as it was in the original request.
#data = '{\n    "script": "INT. COFFEE SHOP - DAY\\n\\nANNA sips her coffee, lost in thought.\\n\\nMARK\\nA penny for them?\\n\\nEXT. PARK - DAY\\n\\nAnna walks through the park. Leaves crunch under her feet. She checks her phone, then sighs."\n  }'
#response = requests.post('https://script-ai-worker.femivideograph.workers.dev/process', headers=headers, data=data)